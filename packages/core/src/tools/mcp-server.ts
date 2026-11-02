import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Logger } from "../types.js";
import type { Tool } from "./tool.js";

/**
 * Reject oversized request bodies before JSON decoding.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Bound admitted body reads and tool calls together.
 */
const MAX_REQUESTS = 32;

/**
 * Refuse plugin teardown when admitted tools have not settled within this deadline.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Host configuration for exporting selected global tools. Port zero requests an ephemeral port.
 */
const McpServerOptionsSchema = z
  .object({
    port: z.number().int().min(0).max(65535),
    token: z
      .string()
      .min(1)
      .refine((token) => token.trim().length > 0, "Use a nonempty bearer token"),
    tools: z.array(z.string().min(1).max(100)).max(1000),
    toolTimeoutMs: z.number().int().min(1).max(3_600_000).default(300_000),
  })
  .strict();

/**
 * Host configuration for the optional authenticated loopback endpoint.
 */
export type McpServerOptions = z.input<typeof McpServerOptionsSchema>;

/**
 * Serve a fixed selection of global tools without granting session authority.
 */
export function createMcpServer(opts: {
  config: McpServerOptions;
  tools: ReadonlyMap<string, Tool>;
  name: string;
  logger: Logger;
}) {
  const config = McpServerOptionsSchema.parse(opts.config);
  const selected = new Map<string, Tool>();
  for (const name of config.tools) {
    if (selected.has(name)) throw new Error(`Duplicate MCP tool: ${name}`);
    const tool = opts.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    selected.set(name, tool);
  }
  const manifest = [...selected.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }),
  }));
  const pending = new Set<Promise<void>>();
  const executions = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  let accepting = false;
  const http = createServer((request, response) => {
    const operation = handle(request, response).catch(() => {
      opts.logger.error("MCP request failed");
      if (!response.headersSent) rejectRequest(response, 500, "MCP request failed");
      else response.end();
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "no-store");
    const expected = Buffer.from(`Bearer ${config.token}`);
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      rejectRequest(response, 401, "Unauthorised");
      return;
    }
    if (
      request.headers.origin ||
      !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host ?? "")
    ) {
      rejectRequest(response, 403, "Only loopback clients are supported");
      return;
    }
    if (!accepting) {
      rejectRequest(response, 503, "MCP server is stopping");
      return;
    }
    if (request.url !== "/mcp") {
      rejectRequest(response, 404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      rejectRequest(response, 405, "Use MCP POST requests");
      return;
    }
    if (pending.size >= MAX_REQUESTS || executions.size >= MAX_REQUESTS) {
      rejectRequest(response, 429, "Too many MCP requests");
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      rejectRequest(response, 415, "Use application/json");
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        response.setHeader("connection", "close");
        response.once("finish", () => request.destroy());
        rejectRequest(response, 413, "MCP request too large");
        return;
      }
      chunks.push(buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      rejectRequest(response, 400, "Invalid JSON");
      return;
    }
    if (Array.isArray(body)) {
      rejectRequest(response, 400, "MCP batch requests are not supported");
      return;
    }
    const connection = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) connection.abort(new Error("MCP client disconnected"));
    });
    const server = new Server({ name: opts.name, version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manifest }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const tool = selected.get(params.name);
      if (!tool) return failure("Unknown MCP tool");
      if (executions.size >= MAX_REQUESTS) return failure("Too many MCP tool calls");
      const controller = new AbortController();
      controllers.add(controller);
      const signal = AbortSignal.any([controller.signal, extra.signal, connection.signal]);
      const deadline = setTimeout(
        () => controller.abort(new Error("MCP tool timed out")),
        config.toolTimeoutMs,
      );
      deadline.unref();
      let onAbort: (() => void) | undefined;
      try {
        const parsed = tool.input.safeParse(params.arguments ?? {});
        if (!parsed.success) return failure(`Invalid arguments for ${tool.name}`);
        signal.throwIfAborted();
        const aborted = new Promise<never>((resolve, reject) => {
          onAbort = () => reject(new Error("MCP tool call cancelled or timed out"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const execution = Promise.resolve().then(() =>
          tool.execute(parsed.data, {
            caller: { kind: "mcp" },
            logger: opts.logger,
            signal,
          }),
        );
        executions.add(execution);
        void execution.then(
          () => executions.delete(execution),
          () => executions.delete(execution),
        );
        const result = await Promise.race([execution, aborted]);
        return CallToolResultSchema.parse(
          typeof result === "string" ? { content: [{ type: "text", text: result }] } : result,
        );
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message.replaceAll(config.token, "[redacted]")
            : "Tool execution failed";
        opts.logger.error("MCP tool failed", { tool: tool.name, error: message });
        return failure(message);
      } finally {
        clearTimeout(deadline);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        controllers.delete(controller);
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await server.close();
    }
  }

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(config.port, "127.0.0.1", () => {
          http.removeListener("error", reject);
          accepting = true;
          resolve();
        });
      });
      const address = http.address();
      if (!address || typeof address === "string")
        throw new Error("MCP listener has no TCP address");
      opts.logger.log("MCP listening", {
        url: `http://127.0.0.1:${address.port}/mcp`,
        tools: selected.size,
      });
    },
    async stop() {
      accepting = false;
      const closed = new Promise<void>((resolve, reject) => {
        http.close((err) => {
          if (err && !("code" in err && err.code === "ERR_SERVER_NOT_RUNNING")) reject(err);
          else resolve();
        });
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await Promise.all([closed, ...pending]);
            await Promise.allSettled([...executions]);
          })(),
          new Promise<never>((resolve, reject) => {
            deadline = setTimeout(
              () => {
                for (const controller of controllers)
                  controller.abort(new Error("MCP shutdown timed out"));
                http.closeAllConnections();
                reject(new Error("MCP tools did not stop; plugin teardown was withheld"));
              },
              Math.min(config.toolTimeoutMs, SHUTDOWN_TIMEOUT_MS),
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/**
 * Return an HTTP error without exposing request contents or credentials.
 */
function rejectRequest(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}

/**
 * Keep rejected calls distinct from successful tool results.
 */
function failure(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
