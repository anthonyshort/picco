import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgent, silentLogger, tool } from "@picco-agent/core";
import { FakeRuntime } from "@picco-agent/core/testing";
import { z } from "zod";

await runMcpServerSmoke();

/**
 * Exercise the packaged inbound MCP server without a model or external service.
 */
async function runMcpServerSmoke(): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "picco-mcp-server-smoke-"));
  const token = randomBytes(32).toString("hex");
  const clients: Client[] = [];
  const runtime = new FakeRuntime();
  let url = "";
  let pluginStopped = false;
  let calls = 0;
  const agent = createAgent({
    name: "mcp-server-smoke",
    dataDir,
    runtime,
    mcp: { port: 0, token },
    logger: {
      ...silentLogger(),
      log(message, data) {
        if (message === "MCP listening") url = z.string().parse(data?.url);
      },
    },
    plugins: [
      {
        name: "probe",
        tools: [
          tool({
            name: "private_probe",
            description: "Agent-only probe",
            input: z.object({}),
            execute() {
              assert.fail("Agent-only tools must not execute through MCP");
            },
          }),
        ],
        mcpTools: [
          tool({
            name: "echo",
            description: "Echo through MCP",
            input: z.object({ text: z.string().max(100) }),
            execute({ text }, ctx) {
              assert.deepEqual(ctx.caller, { kind: "mcp" });
              assert.equal(ctx.user, undefined);
              assert.equal(ctx.execution, undefined);
              calls++;
              return `MCP: ${text}`;
            },
          }),
        ],
        stop() {
          pluginStopped = true;
        },
      },
    ],
  });

  const watchdog = setTimeout(() => {
    console.error("[mcp-server] FAIL: smoke test exceeded 30 seconds");
    process.exit(1);
  }, 30_000);

  try {
    await agent.start({ handleSignals: false });
    assert.notEqual(url, "", "Server must report its ephemeral listener URL");
    const unauthorised = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorised.status, 401);
    await unauthorised.text();
    console.log("[mcp-server] PASS: unauthenticated requests are rejected");

    for (const text of ["first connection", "reconnected"]) {
      const client = new Client({ name: "picco-server-smoke", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map(({ name }) => name),
        ["echo"],
      );
      const result = await client.callTool({ name: "echo", arguments: { text } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.content, [{ type: "text", text: `MCP: ${text}` }]);
      const privateResult = await client.callTool({ name: "private_probe", arguments: {} });
      assert.equal(privateResult.isError, true);
      await client.close();
      console.log(`[mcp-server] PASS: isolated discovery and authenticated call (${text})`);
    }
    assert.equal(calls, 2);
    assert.equal(runtime.spawns.length, 0, "MCP calls must not require an agent session");
    await agent.stop();
    assert.equal(pluginStopped, true);
    await assert.rejects(fetch(url), "Listener must close when the agent stops");
    console.log("[mcp-server] PASS: shutdown closes the listener and stops plugins");
  } finally {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await agent.stop();
    } finally {
      clearTimeout(watchdog);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}
