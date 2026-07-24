/**
 * End-to-end contract for the credential proxy against the REAL pi-mcp-adapter: a real agent
 * (local() runtime, real worker, real MCP transport) whose speaker has NOT connected the service.
 *
 * The proxy fails the connect closed with a JSON-RPC error carrying the teachable /connect message;
 * pi-mcp-adapter contains the failure (lazy connect, 60s backoff, explicit retry via mcp({ connect
 * })) — the worker survives, the server just lists as not connected, and NOTHING reaches the
 * upstream MCP server without a credential. A scripted OpenAI-completions endpoint stands in for
 * the model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { connections } from "@picco-agent/identity";
import { token } from "@picco-agent/connectors";
import { fileStore } from "@picco-agent/identity/store";
import { startFakeModel, lastToolText } from "./fake-model.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("MCP credential proxy against the real pi-mcp-adapter", () => {
  test("an unconnected user's connector fails closed: not connected, nothing upstream, worker survives", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "identity-int-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    const model = await startFakeModel((params) =>
      params.messages.some((m) => m.role === "tool")
        ? [{ text: `STATUS >>> ${lastToolText(params)}` }]
        : [{ toolCall: { name: "mcp", args: {} } }],
    );
    cleanups.push(() => model.close());

    // The upstream MCP server must never be contacted — nobody connected.
    const upstreamCalls: string[] = [];
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
          connectors: [token({ name: "linear", mcp: { url: "http://127.0.0.1:1/never" } })],
          fetch: async (url) => {
            upstreamCalls.push(url);
            throw new Error("no request may reach upstream without a credential");
          },
        }),
      ],
    });
    await agent.start({ handleSignals: false });
    cleanups.push(() => agent.stop());

    const result = await agent.sessions.run("chat", "What MCP servers do you see?", {
      timeoutMs: 90_000,
      user: { source: "telegram", id: "123", display: "anthony" },
    });

    // The worker survived the refused connect, and the session sees the
    // connector's server as configured-but-not-connected — pi-mcp-adapter's
    // own status output teaches mcp({ connect }) as the retry.
    expect(result.text).toContain("STATUS >>> ");
    expect(result.text).toContain("linear");
    expect(result.text).toContain("not connected");

    // Fails closed: nothing was sent upstream without a credential.
    expect(upstreamCalls).toEqual([]);
  }, 120_000);
});
