import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createAgent, tool } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { buildBwrapArgs, bwrap } from "@picco-agent/runtime-bwrap";
import { z } from "zod";
import { startFakeModel, lastToolText } from "./fake-model.js";
import { startFakeMcp } from "./fake-mcp.js";

/**
 * Probe namespace support without requiring Pi or a model.
 */
function sandboxAvailable(): boolean {
  const cwd = mkdtempSync(path.join(os.homedir(), ".shared-profile-probe-"));
  try {
    execFileSync("bwrap", [...buildBwrapArgs(cwd), "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const hasSandbox = sandboxAvailable();
if (process.env.PICCO_REQUIRE_BWRAP === "1" && !hasSandbox)
  throw new Error("Bubblewrap is required but its sandbox probe failed");

describe.each([
  { name: "local", runtime: local, enabled: true },
  { name: "bwrap", runtime: bwrap, enabled: hasSandbox },
])("$name shared profile", ({ runtime, enabled }) => {
  test("rejects a session alias into the shared profile before writing a bridge", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "profile-alias-test-"));
    const agentDir = path.join(workspace, "profile");
    const alias = path.join(workspace, "alias");
    mkdirSync(agentDir);
    symlinkSync(agentDir, alias);
    try {
      await expect(
        runtime({ agentDir }).spawn({
          ref: { source: "test", key: "alias" },
          cwd: alias,
          pi: {},
          env: {},
          bridge: { url: "http://localhost/call", token: "test-token" },
        }),
      ).rejects.toThrow("outside the session directory");
      expect(readdirSync(agentDir)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(!enabled)(
    "preserves worker identity, profile authentication and conversation across reload and restart",
    async () => {
      // /tmp is hidden by the sandbox's private tmpfs.
      const workspace = mkdtempSync(path.join(os.homedir(), ".shared-profile-test-"));
      const agentDir = path.join(workspace, "profile");
      mkdirSync(agentDir);
      const mcp = await startFakeMcp();
      const model = await startFakeModel((params) => {
        const last = params.messages.at(-1);
        if (last?.role === "tool") return [{ text: lastToolText(params) }];
        return [
          {
            toolCall: JSON.stringify(last?.content).includes("MCP")
              ? { name: "mcp__probe__echo", args: { text: "shared-profile" } }
              : { name: "worker_identity", args: {} },
          },
        ];
      });
      const files = {
        "settings.json": JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" }),
        "models.json": JSON.stringify({
          providers: {
            fake: {
              baseUrl: model.url,
              api: "openai-completions",
              models: [{ id: "fake-1" }],
            },
          },
        }),
        "auth.json": JSON.stringify({ fake: { type: "api_key", key: "shared-test-key" } }),
        "mcp.json": JSON.stringify({
          mcpServers: {
            probe: {
              url: mcp.url,
              exposure: "direct",
              auth: { provider: "fake" },
            },
          },
        }),
      };
      for (const [name, content] of Object.entries(files))
        writeFileSync(path.join(agentDir, name), content);
      const makeAgent = () =>
        createAgent({
          name: "shared-profile",
          dataDir: path.join(workspace, "state"),
          runtime: runtime({ agentDir }),
          plugins: [
            {
              name: "identity",
              tools: [
                tool({
                  name: "worker_identity",
                  description: "Identify the calling worker.",
                  input: z.object({}),
                  execute(...[, ctx]) {
                    return ctx.caller.kind === "session" ? ctx.caller.ref.key : "host";
                  },
                }),
              ],
            },
          ],
        });
      let agent = makeAgent();
      try {
        await agent.start({ handleSignals: false });
        const results = await Promise.all(
          ["left", "right"].map((key) =>
            agent.sessions.run(key, `Remember ${key}-private-marker and identify yourself.`),
          ),
        );
        expect(results.map((result) => result.text)).toEqual(["left", "right"]);
        const workers = ["left", "right"].map((key) => agent.sessions.get(key)!);
        const connections = workers.map((worker) => {
          const bridge = path.join(worker.cwd, ".picco/bridge.json");
          expect(statSync(bridge).mode & 0o777).toBe(0o600);
          expect(readdirSync(worker.cwd).some((name) => name.endsWith(".jsonl"))).toBe(true);
          return JSON.parse(readFileSync(bridge, "utf8"));
        });
        expect(connections[0].token).not.toBe(connections[1].token);
        await agent.sessions.run("left", "Call MCP echo.");
        expect(
          mcp.requests.some(
            (request) =>
              request.method === "tools/call" && request.authorization === "Bearer shared-test-key",
          ),
        ).toBe(true);
        const skill = path.join(agentDir, "reload-probe.md");
        writeFileSync(
          skill,
          "---\nname: shared-reload\ndescription: SHARED_RELOAD_MARKER\n---\nRead only.\n",
        );
        files["settings.json"] = JSON.stringify({
          defaultProvider: "fake",
          defaultModel: "fake-1",
          skills: [skill],
        });
        writeFileSync(path.join(agentDir, "settings.json"), files["settings.json"]);
        const requestsBeforeReload = model.requests.length;
        const operation = workers[0]!.reload();
        await operation.completed;
        expect(operation.status).toBe("completed");
        expect(model.requests).toHaveLength(requestsBeforeReload);
        expect((await agent.sessions.run("left", "Identify yourself after reload.")).text).toBe(
          "left",
        );
        expect(JSON.stringify(model.requests.at(-1)!.params.messages)).toContain(
          "SHARED_RELOAD_MARKER",
        );
        await agent.stop();
        agent = makeAgent();
        await agent.start({ handleSignals: false });
        expect((await agent.sessions.run("left", "Identify yourself after restart.")).text).toBe(
          "left",
        );
        expect((await agent.sessions.run("right", "Call MCP echo after restart.")).text).toContain(
          "MCP echo: shared-profile",
        );
        const resumed = JSON.stringify(model.requests.at(-1)!.params.messages);
        expect(resumed).toContain("right-private-marker");
        expect(resumed).not.toContain("left-private-marker");
        expect(
          model.requests.every((request) => request.authorization === "Bearer shared-test-key"),
        ).toBe(true);
        for (const [name, content] of Object.entries(files))
          expect(readFileSync(path.join(agentDir, name), "utf8")).toBe(content);
        expect(
          readdirSync(agentDir).some((name) => name.endsWith(".jsonl") || name === "bridge.json"),
        ).toBe(false);
      } finally {
        await agent.stop();
        await model.close();
        await mcp.close();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
