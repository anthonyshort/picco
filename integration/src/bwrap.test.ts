import { startFakeMcp } from "./fake-mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildBwrapArgs, bwrap } from "@picco-agent/runtime-bwrap";
import { createAgent } from "@picco-agent/core";
import { lastToolText, startFakeModel, type ChatRequest } from "./fake-model.js";

// Workspaces must live outside /tmp: the sandbox mounts a fresh tmpfs over
// /tmp, which would shadow a workspace bound beneath it.
function makeWorkspaceRoot(): string {
  return mkdtempSync(path.join(os.homedir(), ".agent-test-"));
}

function isSandboxAvailable(): boolean {
  const dir = makeWorkspaceRoot();
  try {
    execFileSync("bwrap", [...buildBwrapArgs(dir), "true"], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() },
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Probed once at collection time — every describe below skips without it.
const sandboxAvailable = isSandboxAvailable();
if (process.env.PICCO_REQUIRE_BWRAP === "1" && !sandboxAvailable) {
  throw new Error("Bubblewrap is required in this environment, but its sandbox probe failed.");
}

describe.skipIf(!sandboxAvailable)("bwrap().exec (real bwrap)", () => {
  const runtime = bwrap();

  test("runs the command in the sandbox and returns its stdout", async () => {
    const cwd = makeWorkspaceRoot();
    try {
      const out = await runtime.exec({
        cwd,
        command: "echo sandbox-ok && pwd",
        timeoutMs: 15_000,
      });
      expect(out).toContain("sandbox-ok");
      // --chdir puts the script in its own workspace
      expect(out).toContain(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects with stderr when the command fails", async () => {
    const cwd = makeWorkspaceRoot();
    try {
      await expect(
        runtime.exec({
          cwd,
          command: "echo went-wrong >&2; exit 3",
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow("went-wrong");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("cannot read the host project directory (where .env lives)", async () => {
    const cwd = makeWorkspaceRoot();
    try {
      await expect(
        runtime.exec({
          cwd,
          command: `cat ${process.cwd()}/package.json`,
          timeoutMs: 15_000,
        }),
      ).rejects.toThrow(/No such file/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test.skipIf(!existsSync(path.join(os.homedir(), ".pi", "agent")))(
    "the user's ~/.pi is not visible inside the sandbox",
    async () => {
      const cwd = makeWorkspaceRoot();
      try {
        const out = await runtime.exec({
          cwd,
          command: `test ! -e ${os.homedir()}/.pi && echo user-pi-invisible`,
          timeoutMs: 15_000,
        });
        expect(out).toContain("user-pi-invisible");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(!sandboxAvailable)("bwrap() session lifecycle (real bwrap)", () => {
  test("check() verifies bwrap, node, and pi are available", async () => {
    await expect(bwrap().check()).resolves.toBeUndefined();
  });

  test("spawn(spec) starts the real worker in the jail — its imports resolve", async () => {
    const cwd = makeWorkspaceRoot();
    const runtime = bwrap();
    try {
      // An empty pi config: the worker boots, imports the pi SDK from the
      // mounted trees, and either reaches RPC mode or dies with a clean
      // worker-tagged error (no model). A module-resolution hole would
      // instead kill it with "Cannot find module".
      const proc = await runtime.spawn({
        ref: { source: "test", key: "k" },
        cwd,
        env: {},
        pi: {},
        bridge: { url: "" },
      });

      const stderrChunks: string[] = [];
      const decoder = new TextDecoder();
      const drain = (async () => {
        for await (const chunk of proc.stderr) stderrChunks.push(decoder.decode(chunk));
      })();

      // Give a crashing worker ample time to die; a worker still alive
      // after this window has long since finished importing.
      await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(r, 15_000, null))]);
      await proc.kill();
      await drain.catch(() => {});
      const stderr = stderrChunks.join("");

      // The worker should not fail with module resolution errors.
      // It may exit with a diagnostic (no model configured) or an OpenSSL
      // warning from the host's crypto config — both are acceptable as long
      // as the imports resolved.
      expect(stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});

describe.skipIf(!sandboxAvailable)("bwrap() + native MCP (real bwrap)", () => {
  test("calls a native MCP tool inside the sandbox", async () => {
    const workspace = makeWorkspaceRoot();
    const mcp = await startFakeMcp();
    const model = await startFakeModel((params) =>
      params.messages.some((m) => m.role === "tool")
        ? [{ text: `STATUS >>> ${lastToolText(params)}` }]
        : [{ toolCall: { name: "mcp__probe__echo", args: { text: "sandbox" } } }],
    );
    const agent = createAgent({
      name: "bwrap-mcp-int",
      dataDir: workspace,
      runtime: bwrap(),
      pi: {
        model: "fake/fake-1",
        models: {
          providers: {
            fake: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "test-key",
              models: [{ id: "fake-1" }],
            },
          },
        },
        mcpServers: { probe: { url: mcp.url, exposure: "direct" } },
      },
    });
    await agent.start({ handleSignals: false });
    try {
      const result = await agent.sessions.run("chat", "What MCP servers do you see?", {
        timeoutMs: 240_000,
      });
      expect(result.text).toContain("MCP echo: sandbox");
      expect(mcp.requests.some((request) => request.method === "tools/call")).toBe(true);
    } finally {
      await agent.stop();
      await model.close();
      await mcp.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});

describe.skipIf(!sandboxAvailable)("bwrap() session resume (real bwrap)", () => {
  test("resumes the conversation across a sandbox respawn — the transcript persists via the rw mount", async () => {
    const workspace = makeWorkspaceRoot();
    const requests: ChatRequest[] = [];
    const model = await startFakeModel((params) => {
      requests.push(params);
      return [{ text: "ok" }];
    });
    const makeAgent = () =>
      createAgent({
        name: "bwrap-resume-int",
        dataDir: workspace,
        runtime: bwrap(),
        pi: {
          model: "fake/fake-1",
          models: {
            providers: {
              fake: {
                baseUrl: model.url,
                api: "openai-completions",
                apiKey: "test-key",
                models: [{ id: "fake-1" }],
              },
            },
          },
        },
      });
    let agent = makeAgent();
    await agent.start({ handleSignals: false });
    try {
      await agent.sessions.run("chat", "Remember the codeword: bluejay.", { timeoutMs: 240_000 });

      // Simulate an involuntary respawn (agent restart / crash): stop the agent — kills the jailed
      // worker, but the session dir persists on the host via the rw mount — then a fresh agent on
      // the same dataDir respawns the session in a new jail that mounts the same dir.
      await agent.stop();
      agent = makeAgent();
      await agent.start({ handleSignals: false });

      await agent.sessions.run("chat", "What was the codeword?", { timeoutMs: 240_000 });

      // The post-respawn model request carries the first turn's message: the transcript survived
      // the sandbox boundary (rw mount) and pi resumed it (--continue), not a fresh conversation.
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("bluejay");
    } finally {
      await agent.stop();
      await model.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 300_000);
});
