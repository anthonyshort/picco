import type { ExecutionRef } from "../session/execution.js";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as z from "zod";
import { silentLogger } from "../utils/logger.js";
import type { Caller, ContentBlock, SessionCaller, Tool, ToolContext, ToolResult } from "./tool.js";
import type { Logger, SessionIdentity, SessionRef } from "../types.js";

/**
 * The /call request body: which tool to run and its (unvalidated) args. The tool's own schema
 * validates `args` downstream in {@link runTool}.
 */
const CallSchema = z.object({
  tool: z.string(),
  args: z.unknown().optional(),
});

/**
 * Log a warning when a /call body exceeds this many bytes. Advisory only — the body is uncapped.
 */
const LARGE_BODY_WARN_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the calling session's current sender (the sticky pin). Looked up per call, so mid-session
 * tools see the current turn's user.
 */
type CurrentUserResolver = (ref: SessionRef) => SessionIdentity | undefined;

export interface ToolBridgeOptions {
  /**
   * Live tool map — additions after start are served to later requests.
   */
  tools: Map<string, Tool>;
  logger?: Logger;
  currentUser?: CurrentUserResolver;
  /**
   * When configured, tools require a running execution and inherit its trusted identity.
   */
  executionContext?: (ref: SessionRef) => BridgeExecutionContext | undefined;
}

/**
 * Execution ownership is pinned before an admitted request starts reading its body.
 */
interface BridgeExecutionContext {
  execution: ExecutionRef;
  signal: AbortSignal;
}

/**
 * Outcome of one tool invocation — the shape the /call route serializes.
 */
export interface RunToolResult {
  content: ContentBlock[];
  isError: boolean;
}

interface TokenEntry {
  caller: SessionCaller;
  /**
   * Tools bound to this session only, served alongside the agent-wide map.
   */
  sessionTools: Map<string, Tool>;
}

/**
 * The loopback HTTP server sessions call to execute host tools.
 */
export class ToolBridge {
  private readonly tools: Map<string, Tool>;
  private readonly logger: Logger;
  private readonly currentUser?: CurrentUserResolver;
  private readonly executionContext?: ToolBridgeOptions["executionContext"];
  private readonly pendingCalls = new Map<string, Set<Promise<void>>>();
  private readonly tokens = new Map<string, TokenEntry>();
  private httpServer: Server | null = null;
  private boundPort = 0;

  constructor(opts: ToolBridgeOptions) {
    this.tools = opts.tools;
    this.logger = opts.logger ?? silentLogger();
    this.currentUser = opts.currentUser;
    this.executionContext = opts.executionContext;
  }

  /**
   * Listen on 127.0.0.1 (ephemeral port unless given).
   */
  async start(port = 0): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.httpServer = server;
    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : port;
    this.logger.log("tool bridge listening", { url: this.callUrl(), tools: this.tools.size });
  }

  /**
   * Close the server and drop every session token.
   */
  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.tokens.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  /**
   * Plain-JSON tool invocation endpoint — what the session worker calls.
   */
  callUrl(): string {
    return `http://127.0.0.1:${this.boundPort}/call`;
  }

  /**
   * Create a bearer token identifying one session as the caller. Session-scoped tools are validated
   * here — throwing fails the session creation, before the session process spawns.
   */
  issueToken(caller: SessionRef, sessionTools?: Tool[]): string {
    const bound = new Map<string, Tool>();
    for (const tool of sessionTools ?? []) {
      if (this.tools.has(tool.name) || bound.has(tool.name)) {
        throw new Error(
          `Session-scoped tool "${tool.name}" (session ${caller.source}/${caller.key}) collides with an existing tool`,
        );
      }
      if (!(tool.input instanceof z.ZodObject)) {
        throw new Error(`Tool "${tool.name}": input must be a z.object(...) schema`);
      }
      bound.set(tool.name, tool);
    }
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { caller: { kind: "session", ref: caller }, sessionTools: bound });
    return token;
  }

  /**
   * Release every token issued to a session (session teardown).
   */
  releaseSession(ref: SessionRef): void {
    for (const [token, { caller }] of this.tokens) {
      if (caller.ref.source === ref.source && caller.ref.key === ref.key) this.tokens.delete(token);
    }
  }

  /**
   * Number of live tokens (for tests/introspection).
   */
  get tokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Authenticate the request, then dispatch to the /call handler.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const entry = this.tokens.get(token);

    // POST /call — execute a host tool.
    if (req.url !== "/call") {
      res.writeHead(404).end();
      return;
    }
    if (!entry) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const execution = this.executionContext?.(entry.caller.ref);
    if (this.executionContext && (!execution || execution.signal.aborted)) {
      res.writeHead(409).end("No running execution owns this tool call");
      return;
    }
    const pending = this.handleCall(req, res, token, entry, execution);
    const id = execution?.execution.id;
    if (id) {
      const calls = this.pendingCalls.get(id) ?? new Set<Promise<void>>();
      this.pendingCalls.set(id, calls);
      calls.add(pending);
      void pending
        .finally(() => {
          calls.delete(pending);
          if (!calls.size) this.pendingCalls.delete(id);
        })
        .catch(() => {});
    }
    await pending;
  }

  /**
   * POST /call: { tool, args } → { content, isError }. Every tool-level failure (unknown name,
   * rejected args, a throwing execute) is a 200 isError result the model sees — 4xx is reserved for
   * protocol misuse.
   */
  private async handleCall(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    entry: TokenEntry,
    execution?: BridgeExecutionContext,
  ): Promise<void> {
    let parsed: z.infer<typeof CallSchema>;
    try {
      const body = await readBody(req, execution?.signal);
      // Loopback-only from the trusted worker, so the body is uncapped; a surprisingly large one is
      // worth a warning as an observability signal, not a hard limit.
      const bytes = Buffer.byteLength(body);
      if (bytes > LARGE_BODY_WARN_BYTES) {
        this.logger.warning("large tool-call body", { bytes });
      }
      const result = CallSchema.safeParse(JSON.parse(body));
      if (!result.success) {
        res.writeHead(400).end("invalid request body");
        return;
      }
      parsed = result.data;
    } catch {
      if (execution?.signal.aborted) res.destroy();
      else res.writeHead(400).end("invalid JSON body");
      return;
    }
    if (this.tokens.get(token) !== entry) {
      res.writeHead(401).end();
      return;
    }
    const current = this.executionContext?.(entry.caller.ref);
    if (
      this.executionContext &&
      (!current ||
        current.execution.id !== execution?.execution.id ||
        execution?.signal.aborted ||
        current.signal.aborted)
    ) {
      res.writeHead(409).end("The tool call's owning execution has ended");
      return;
    }
    // Agent-wide tools are shared by every session; sessionTools are scoped to this token. A name
    // resolves to one or the other — issueToken rejects a session tool that collides with an
    // agent-wide one.
    const tool = this.tools.get(parsed.tool) ?? entry.sessionTools.get(parsed.tool);
    const { caller } = entry;
    const operation = tool
      ? this.runTool(tool, parsed.args, {
          logger: this.logger,
          caller,
          // Resolved per call: the sticky pin may change between turns.
          user: this.currentUser?.(caller.ref),
          execution: execution?.execution,
          signal: execution?.signal,
        })
      : {
          content: [{ type: "text" as const, text: `Error: unknown tool "${parsed.tool}"` }],
          isError: true,
        };
    const result = await operation;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  }

  /**
   * Await admitted requests, including body reads, before critical ownership can be released.
   */
  async settleExecution(id: string): Promise<void> {
    await Promise.allSettled(this.pendingCalls.get(id) ?? []);
  }

  /**
   * Validate args and execute a tool, normalizing every failure into an isError result the model
   * sees and can react to. Never throws.
   */
  private async runTool(tool: Tool, args: unknown, ctx: ToolContext): Promise<RunToolResult> {
    this.logger.log("tool call", { tool: tool.name, caller: describeCaller(ctx.caller) });

    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      const message = `Error: invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`;
      this.logger.error("tool rejected args", { tool: tool.name, error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }

    try {
      const result = await tool.execute(parsed.data as never, ctx);
      return { content: toContent(result), isError: false };
    } catch (err) {
      // A thrown execute() is a tool error the model sees and can react to.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("tool failed", { tool: tool.name, error: message });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
}

/**
 * Format the caller identity for log lines.
 */
function describeCaller(caller: Caller): string {
  switch (caller.kind) {
    case "session":
      return `session:${caller.ref.source}/${caller.ref.key}`;
    case "host":
      return "host";
    default:
      throw new Error(`Unknown caller kind: ${(caller as Caller).kind}`);
  }
}

/**
 * Normalize a ToolResult (bare string or content blocks) into blocks.
 */
function toContent(result: ToolResult): ContentBlock[] {
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  return result.content;
}

/**
 * Collect a request body as a UTF-8 string. Buffers the raw chunks and decodes once — decoding each
 * chunk on its own would corrupt a multi-byte character split across a chunk boundary.
 */
async function readBody(req: IncomingMessage, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("Tool request owner has ended");
  const abort = () => req.destroy(new Error("Tool request owner has ended"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
