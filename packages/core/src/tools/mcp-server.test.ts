import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgent } from "../agent.js";
import { FakeRuntime } from "../testing/fake-runtime.js";
import { silentLogger } from "../utils/logger.js";
import type { AgentConfig, AgentHandle, Plugin } from "../types.js";
import { tool, type ToolContext } from "./tool.js";

/**
 * Allow tests to contribute MCP tools through a fixture plugin.
 */
type McpTestConfig = Partial<AgentConfig> & Pick<Plugin, "mcpTools">;

let directory: string;
let agents: AgentHandle[];
let clients: Client[];

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "picco-mcp-"));
  agents = [];
  clients = [];
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  for (const agent of agents) await agent.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe("MCP server", () => {
  test("discovers plugin MCP tools separately from agent tools and validates transformed input once", async () => {
    const contexts: ToolContext[] = [];
    const runtime = new FakeRuntime();
    const echo = tool({
      name: "echo",
      description: "Echo a quantity",
      input: z.object({
        quantity: z
          .number()
          .default(2)
          .transform((quantity) => quantity * 3),
      }),
      execute(input, context) {
        contexts.push(context);
        return JSON.stringify(input);
      },
    });
    const hidden = tool({
      name: "hidden",
      description: "Private",
      input: z.object({}),
      execute: () => "private",
    });
    const { agent, url } = await start({
      runtime,
      plugins: [{ name: "sample", tools: [hidden], mcpTools: [echo] }],
    });
    const client = await connect(url);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["echo"]);
    expect(listed.tools[0].inputSchema.properties).toMatchObject({
      quantity: { type: "number", default: 2 },
    });
    expect(await client.callTool({ name: "echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: '{"quantity":6}' }],
    });
    expect(await client.callTool({ name: "echo", arguments: { quantity: 4 } })).toMatchObject({
      content: [{ type: "text", text: '{"quantity":12}' }],
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0].caller).toEqual({ kind: "mcp" });
    expect(contexts[0].user).toBeUndefined();
    expect(contexts[0].execution).toBeUndefined();
    expect(contexts[0].token).toBeUndefined();
    expect(
      await client.callTool({ name: "echo", arguments: { quantity: "invalid" } }),
    ).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "hidden", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(await client.callTool({ name: "reload", arguments: {} })).toMatchObject({
      isError: true,
    });
    const session = await agent.sessions.open("one", {
      tools: [
        tool({
          name: "private_session",
          description: "Session only",
          input: z.object({}),
          execute: () => "private",
        }),
      ],
    });
    expect(session.key).toBe("one");
    expect(await client.callTool({ name: "private_session", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(contexts).toHaveLength(2);
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0].spec.tools?.map(({ name }) => name)).toEqual([
      "hidden",
      "reload",
      "private_session",
    ]);
  });

  test("allows the same name to have separate schemas and handlers for agents and MCP clients", async () => {
    const runtime: FakeRuntime = new FakeRuntime({
      async reply() {
        const { bridge } = runtime.spawns[0].spec;
        const response = await fetch(bridge.url, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: "search", args: { query: "agent input" } }),
        });
        const result = z
          .object({
            content: z.array(z.object({ type: z.literal("text"), text: z.string() })).max(10),
            isError: z.boolean(),
          })
          .parse(await response.json());
        expect(result.isError).toBe(false);
        return result.content[0].text;
      },
    });
    const sessionTool = tool({
      name: "search",
      description: "Search for the agent",
      input: z.object({ query: z.string() }),
      execute: ({ query }) => `Agent: ${query}`,
    });
    const externalTool = tool({
      name: "search",
      description: "Search for external clients",
      input: z.object({ id: z.number() }),
      execute: ({ id }) => `MCP: ${id}`,
    });
    const shared = tool({
      name: "shared",
      description: "Shared explicitly",
      input: z.object({}),
      execute: () => "shared",
    });
    const { agent, url } = await start({
      runtime,
      plugins: [
        {
          name: "search",
          tools: [sessionTool, shared],
          mcpTools: [externalTool, shared],
        },
      ],
    });
    expect((await agent.sessions.run("worker", "Call search")).text).toBe("Agent: agent input");
    const specifications = runtime.spawns[0].spec.tools ?? [];
    expect(specifications.map(({ name }) => name)).toEqual(["search", "shared", "reload"]);
    expect(specifications.find(({ name }) => name === "search")?.inputSchema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    const client = await connect(url);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["search", "shared"]);
    expect(listed.tools.find(({ name }) => name === "search")?.inputSchema).toMatchObject({
      properties: { id: { type: "number" } },
      required: ["id"],
    });
    expect(await client.callTool({ name: "search", arguments: { id: 7 } })).toMatchObject({
      content: [{ type: "text", text: "MCP: 7" }],
    });
    expect(
      await client.callTool({ name: "search", arguments: { query: "agent input" } }),
    ).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "shared", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "shared" }],
    });
  });

  test("returns full rich results and tool failures through real reconnecting clients", async () => {
    const report = "Full report. ".repeat(2000);
    const { url } = await start({
      mcpTools: [
        tool({
          name: "report",
          description: "Report",
          input: z.object({}),
          execute: () => ({
            content: [
              { type: "text", text: report },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          }),
        }),
        tool({
          name: "fail",
          description: "Fail",
          input: z.object({}),
          execute() {
            throw new Error("Rejected secret-token");
          },
        }),
      ],
    });
    const first = await connect(url);
    await first.close();
    const second = await connect(url);
    expect(await second.callTool({ name: "report", arguments: {} })).toMatchObject({
      content: [
        { type: "text", text: report },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(await second.callTool({ name: "fail", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Rejected [redacted]" }],
    });
  });

  test("rejects unauthenticated, browser, foreign-host, malformed and oversized requests before dispatch", async () => {
    let calls = 0;
    const { url } = await start({
      mcpTools: [
        tool({
          name: "probe",
          description: "Probe",
          input: z.object({}),
          execute() {
            calls++;
            return "ok";
          },
        }),
      ],
    });
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Origin: "https://example.com" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(await raw(url, { ...headers, Host: "example.com" }, "{}")).toBe(403);
    expect((await fetch(url, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(url + "/other", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect((await fetch(url, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect(
      (await fetch(url, { method: "POST", headers, body: "x".repeat(64 * 1024 + 1) })).status,
    ).toBe(413);
    expect(await raw(url, headers, "x".repeat(64 * 1024 + 1), true)).toBe(413);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(
            Array.from({ length: 40 }, (_, id) => ({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "probe", arguments: {} },
            })),
          ),
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
  });

  test("bounds concurrent tool work", async () => {
    const allEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const { url } = await start({
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold",
          input: z.object({}),
          async execute() {
            calls++;
            if (calls === 32) allEntered.resolve();
            await release.promise;
            return "done";
          },
        }),
      ],
    });
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hold", arguments: {} },
    });
    const requests = Array.from({ length: 32 }, () =>
      fetch(url, { method: "POST", headers, body }),
    );
    try {
      await allEntered.promise;
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(429);
      expect(calls).toBe(32);
    } finally {
      release.resolve();
      await Promise.all(requests);
    }
  });

  test("waits for plugins at startup and drains admitted calls before stopping them", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const plugin: Plugin = {
      name: "lifetime",
      start() {
        events.push("started");
      },
      stop() {
        events.push("stopped");
      },
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold",
          input: z.object({}),
          async execute() {
            expect(events).toEqual(["started"]);
            entered.resolve();
            await release.promise;
            expect(events).toEqual(["started"]);
            events.push("finished");
            return "done";
          },
        }),
      ],
    };
    const { agent, url } = await start({ plugins: [plugin] });
    const client = await connect(url);
    const result = client.callTool({ name: "hold", arguments: {} });
    await entered.promise;
    const stopped = agent.stop();
    try {
      expect(events).toEqual(["started"]);
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      release.resolve();
    }
    expect(await result).toMatchObject({ content: [{ type: "text", text: "done" }] });
    await stopped;
    expect(events).toEqual(["started", "finished", "stopped"]);
  });

  test("signals a premature client disconnect and waits for cooperative cleanup", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const cancelled = Promise.withResolvers<void>();
    const { agent, url } = await start({
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold",
          input: z.object({}),
          async execute(input, ctx) {
            if (!ctx.signal) throw new Error("Expected cancellation signal");
            entered.resolve(ctx.signal);
            await new Promise<void>((resolve) =>
              ctx.signal!.addEventListener(
                "abort",
                () => {
                  cancelled.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
            return JSON.stringify(input);
          },
        }),
      ],
    });
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    request.on("error", () => {});
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hold", arguments: {} },
      }),
    );
    const signal = await entered.promise;
    request.destroy();
    await cancelled.promise;
    expect(signal.aborted).toBe(true);
    await agent.stop();
  });

  test("keeps timed-out executions within the admission limit until they actually settle", async () => {
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const { agent, url } = await start({
      mcp: { port: 0, token: "secret-token", toolTimeoutMs: 80 },
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold",
          input: z.object({}),
          async execute(input) {
            calls++;
            await release.promise;
            return JSON.stringify(input);
          },
        }),
      ],
    });
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hold", arguments: {} },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 32 }, async () =>
          (await fetch(url, { method: "POST", headers, body })).json(),
        ),
      );
      expect(results).toHaveLength(32);
      expect(
        results.every(
          (result) =>
            z.object({ result: z.object({ isError: z.literal(true) }) }).safeParse(result).success,
        ),
      ).toBe(true);
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(429);
      expect(calls).toBe(32);
    } finally {
      release.resolve();
    }
    await agent.stop();
  });

  test("unwinds plugins when the listener cannot start", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const events: string[] = [];
    const agent = make({
      mcp: { port: address.port, token: "secret-token" },
      plugins: [
        {
          name: "sample",
          start() {
            events.push("start");
          },
          stop() {
            events.push("stop");
          },
        },
      ],
    });
    try {
      await expect(agent.start({ handleSignals: false })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(events).toEqual(["start", "stop"]);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("signals timed-out work and reports failure without assuming teardown", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let url = "";
    const agent = make({
      mcp: { port: 0, token: "secret-token", toolTimeoutMs: 50 },
      logger: {
        ...silentLogger(),
        log(message, data) {
          if (message === "MCP listening") url = z.string().parse(data?.url);
        },
      },
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold",
          input: z.object({}),
          async execute(input, ctx) {
            if (!ctx.signal) throw new Error("Expected cancellation signal");
            entered.resolve(ctx.signal);
            await release.promise;
            return JSON.stringify(input);
          },
        }),
      ],
    });
    await agent.start({ handleSignals: false });
    const client = await connect(url);
    const result = client.callTool({ name: "hold", arguments: {} });
    const signal = await entered.promise;
    expect(await result).toMatchObject({
      isError: true,
      content: [{ text: "MCP tool call cancelled or timed out" }],
    });
    expect(signal.aborted).toBe(true);
    try {
      await expect(agent.stop()).rejects.toThrow("plugin teardown was withheld");
    } finally {
      release.resolve();
    }
    await agent.stop();
  });

  test("validates MCP configuration and rejects duplicate external names across plugins", () => {
    expect(() => make({ mcp: { port: 0, token: " " } })).toThrow();
    const external = tool({
      name: "probe",
      description: "Probe",
      input: z.object({}),
      execute: () => "ok",
    });
    expect(() =>
      make({
        plugins: [
          { name: "one", mcpTools: [external] },
          { name: "two", mcpTools: [external] },
        ],
      }),
    ).toThrow('Duplicate tool name "probe" (contributed by plugin "two" MCP tools)');
  });
});

/**
 * Create an agent with an isolated data directory and no real model runtime.
 */
function make(config: McpTestConfig) {
  const { mcpTools, ...agentConfig } = config;
  const agent = createAgent({
    name: "mcp-test",
    dataDir: directory,
    runtime: new FakeRuntime(),
    logger: silentLogger(),
    ...agentConfig,
    plugins: [
      ...(agentConfig.plugins ?? []),
      ...(mcpTools ? [{ name: "mcp-fixture", mcpTools }] : []),
    ],
  });
  agents.push(agent);
  return agent;
}

/**
 * Read the ephemeral listener URL from the host's supported logger.
 */
async function start(config: McpTestConfig) {
  let url = "";
  const agent = make({
    ...config,
    mcp: { ...config.mcp, port: 0, token: "secret-token" },
    logger: {
      ...silentLogger(),
      log(message, data) {
        if (message === "MCP listening") url = z.string().parse(data?.url);
      },
    },
  });
  await agent.start({ handleSignals: false });
  expect(url).not.toBe("");
  return { agent, url };
}

/**
 * Connect with the real SDK over authenticated loopback HTTP.
 */
async function connect(url: string) {
  const client = new Client({ name: "picco-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: "Bearer secret-token" } },
    }),
  );
  return client;
}

/**
 * Send requests whose Host or chunked body must be controlled below fetch.
 */
function raw(url: string, headers: Record<string, string>, body: string, chunked = false) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    if (chunked) request.write(body);
    request.end(chunked ? undefined : body);
  });
}
