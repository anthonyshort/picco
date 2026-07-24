import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger, SessionRef } from "@picco-agent/core";
import * as z from "zod";
import type { FetchLike, McpSurface } from "../connector/connector.js";

/**
 * Request headers allowed upstream. The session bearer never leaves the host.
 */
const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/**
 * Response headers piped back to the session.
 */
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

/**
 * Log a warning when a proxied body exceeds this many bytes. Advisory only — the body is uncapped,
 * matching the tool bridge's loopback stance.
 */
const LARGE_BODY_WARN_BYTES = 4 * 1024 * 1024;

const JsonRpcRequestSchema = z.object({ id: z.unknown().optional() });

/**
 * Credential resolution result safe to surface through JSON-RPC.
 */
type TokenResolution = { token: string } | { error: string };

/**
 * MCP proxy routes and host-side dependencies.
 */
interface McpProxyOptions {
  routes: Map<string, McpSurface>;
  resolveToken(session: SessionRef, connector: string): Promise<TokenResolution>;
  logger: Logger;
  fetch: FetchLike;
}

/**
 * In-process loopback MCP proxy with per-session bearers.
 */
export class McpProxy {
  private readonly bearers = new Map<string, SessionRef>();
  private httpServer: Server | null = null;
  private boundPort = 0;

  constructor(private readonly opts: McpProxyOptions) {}

  async start(): Promise<void> {
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.httpServer = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.opts.logger.log("mcp credential proxy listening", {
      port: this.boundPort,
      connectors: [...this.opts.routes.keys()].join(", "),
    });
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.bearers.clear();
    if (server) {
      // Piped upstream SSE would otherwise keep close() waiting forever.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  /**
   * Proxy-backed mcp.json entries for one session: one loopback URL per MCP-surfaced connector, all
   * sharing one session bearer.
   */
  sessionServers(
    session: SessionRef,
  ): Record<string, { url: string; headers: Record<string, string> }> {
    if (this.opts.routes.size === 0) return {};
    const bearer = randomBytes(32).toString("hex");
    this.bearers.set(bearer, { ...session });
    const entries: Record<string, { url: string; headers: Record<string, string> }> = {};
    for (const name of this.opts.routes.keys()) {
      entries[name] = {
        url: `http://127.0.0.1:${this.boundPort}/mcp/${encodeURIComponent(name)}`,
        headers: { Authorization: `Bearer ${bearer}` },
      };
    }
    return entries;
  }

  /**
   * Revoke every bearer issued to a session (session teardown).
   */
  release(session: SessionRef): void {
    for (const [bearer, storedSession] of this.bearers) {
      if (storedSession.source !== session.source || storedSession.key !== session.key) continue;
      this.bearers.delete(bearer);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/?]+)$/.exec(request.url ?? "");
    if (!match) {
      response.writeHead(404).end();
      return;
    }

    const session = this.authenticate(request);
    if (!session) {
      response.writeHead(401).end();
      return;
    }

    const connector = decodeURIComponent(match[1]!);
    const route = this.opts.routes.get(connector);
    if (!route) {
      response.writeHead(404).end();
      return;
    }

    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await readBody(request);
    if (body !== null) {
      const bytes = Buffer.byteLength(body);
      if (bytes > LARGE_BODY_WARN_BYTES) {
        this.opts.logger.warning("large proxied mcp body", { connector, bytes });
      }
    }

    const resolution = await this.resolveToken(session, connector);
    if ("error" in resolution) {
      respondJsonRpcError(response, body, resolution.error);
      return;
    }

    await this.forward(request, response, connector, route, resolution.token, body);
  }

  /**
   * The session behind the request's bearer; null = forged or revoked.
   */
  private authenticate(request: IncomingMessage): SessionRef | null {
    const authorization = request.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    return this.bearers.get(bearer) ?? null;
  }

  /**
   * Resolve the current sender's credential; failures become the teachable error, never a throw.
   */
  private async resolveToken(session: SessionRef, connector: string): Promise<TokenResolution> {
    try {
      return await this.opts.resolveToken(session, connector);
    } catch (err) {
      this.opts.logger.error("credential resolution failed", {
        connector,
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: `Resolving credentials for ${connector} failed. Try again.` };
    }
  }

  /**
   * Re-authenticated pass-through: allowlisted headers plus the real token upstream, the response
   * streamed back verbatim.
   */
  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    connector: string,
    route: McpSurface,
    token: string,
    body: string | null,
  ): Promise<void> {
    let upstream: Response;
    try {
      upstream = await this.opts.fetch(route.url, {
        method: request.method,
        headers: upstreamHeaders(request, route, token),
        body,
      });
    } catch (err) {
      this.opts.logger.error("upstream request failed", {
        connector,
        error: err instanceof Error ? err.message : String(err),
      });
      respondJsonRpcError(response, body, `${connector} is unreachable right now.`);
      return;
    }
    await pipeResponse(upstream, response);
  }
}

/**
 * The allowlisted request headers plus the connector's auth header carrying the real token
 * (Bearer-prefixed only on a standard Authorization header).
 */
function upstreamHeaders(
  request: IncomingMessage,
  route: McpSurface,
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const authHeader = route.header ?? "Authorization";
  headers[authHeader] = authHeader.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
  return headers;
}

/**
 * Allowlisted response headers, then the body verbatim — SSE chunks flush as they arrive.
 */
async function pipeResponse(upstream: Response, response: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);

  if (!upstream.body) {
    response.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) {
      response.write(chunk);
    }
  } catch {
    /* upstream dropped mid-stream — nothing to salvage */
  }
  response.end();
}

/**
 * The teachable upstream-unreachable reply: a JSON-RPC error the MCP client surfaces to the model.
 * The request id is echoed when the body holds one.
 */
function respondJsonRpcError(response: ServerResponse, body: string | null, message: string): void {
  let id: unknown = null;
  try {
    const parsed = JsonRpcRequestSchema.safeParse(JSON.parse(body ?? ""));
    if (parsed.success) id = parsed.data.id ?? null;
  } catch {
    /* not JSON (e.g. a GET SSE stream) — id stays null */
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } }));
}

/**
 * Buffer and decode one request body without corrupting split UTF-8 code points.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
