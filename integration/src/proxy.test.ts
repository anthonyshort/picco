import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgent, type Commands } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { connections } from "@picco-agent/identity";
import { token } from "@picco-agent/connectors";
import { fileStore } from "@picco-agent/identity/store";
import { startFakeMcp } from "./fake-mcp.js";
import { startFakeModel, lastToolText } from "./fake-model.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("MCP credential proxy against native Pi MCP", () => {
  test("fails closed before connecting, reconnects, and resolves each turn's user", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "identity-int-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const model = await startFakeModel(() => [{ text: "worker survived" }]);
    cleanups.push(() => model.close());

    let commands!: Commands;
    const agent = createAgent({
      name: "identity-int",
      dataDir: workspace,
      runtime: local(),
      pi: {
        model: "fake/fake-1",
        instructions: "You are a test agent.",
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
      plugins: [
        connections({
          encryptionKey: "2".repeat(64),
          store: fileStore(path.join(workspace, "connections")),
          connectors: [token({ name: "linear", mcp: { url: mcp.url } })],
        }),
        {
          name: "gateway",
          start: (ctx) => {
            commands = ctx.commands;
          },
        },
      ],
    });
    await agent.start({ handleSignals: false });
    cleanups.push(() => agent.stop());

    const result = await agent.sessions.run("chat", "What MCP servers do you see?", {
      timeoutMs: 90_000,
      user: { source: "telegram", id: "123", display: "anthony" },
    });

    expect(result.text).toBe("worker survived");
    expect(mcp.requests).toEqual([]);

    const anthony = { source: "telegram", id: "123", display: "anthony" };
    await commands.dispatch("connect", {
      args: "linear anthony-token",
      user: anthony,
      reply: async () => {},
      dm: async () => {},
    });
    const reconnect = await agent.sessions.run("chat", "/mcp reconnect linear", { user: anthony });
    expect(reconnect.text).toBe("");

    model.setScript((params) =>
      params.messages.at(-1)?.role === "tool"
        ? [{ text: lastToolText(params) }]
        : [
            {
              toolCall: {
                name: "codemode",
                args: { code: 'text(await tools.mcp__linear__echo({text: "hello"}));' },
              },
            },
          ],
    );
    const connected = await agent.sessions.run("chat", "Echo hello", { user: anthony });
    expect(connected.text).toContain("MCP echo: hello");
    expect(
      mcp.requests.filter((request) => request.method === "tools/call").at(-1)?.authorization,
    ).toBe("Bearer anthony-token");

    const alex = { source: "telegram", id: "456", display: "alex" };
    await commands.dispatch("connect", {
      args: "linear alex-token",
      user: alex,
      reply: async () => {},
      dm: async () => {},
    });
    const switched = await agent.sessions.run("chat", "Echo hello again", { user: alex });
    expect(switched.text).toContain("MCP echo: hello");
    expect(
      mcp.requests.filter((request) => request.method === "tools/call").at(-1)?.authorization,
    ).toBe("Bearer alex-token");
    const calls = mcp.requests.length;
    const refused = await agent.sessions.run("chat", "Echo as a third user", {
      user: { source: "telegram", id: "789", display: "unconnected" },
    });
    expect(refused.text).toContain("/connect linear");
    expect(mcp.requests).toHaveLength(calls);
    expect(JSON.stringify(model.requests)).not.toContain("anthony-token");
    expect(JSON.stringify(model.requests)).not.toContain("alex-token");
  }, 120_000);
});
