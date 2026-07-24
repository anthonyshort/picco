import { parseJsonl, JsonlWriter, type JsonObject } from "./jsonl.js";
import { silentLogger } from "../utils/logger.js";
import type { Logger, RuntimeProcess } from "../types.js";
import type { TurnEvent } from "./turn.js";

const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (msg: JsonObject) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcSessionOptions {
  /**
   * Override the per-request RPC timeout (default: 10s). Useful in tests.
   */
  requestTimeoutMs?: number;
  logger?: Logger;
}

export interface PromptOptions {
  /**
   * Abort the turn after this long. The session runtime owns the default and always passes one;
   * without it the prompt waits forever.
   */
  timeoutMs?: number;
  /**
   * Receives live TurnEvents (tool_start/tool_end/text) while the prompt runs.
   */
  onEvent?: (event: TurnEvent) => void;
}

/**
 * The host-side handle for one live session worker process.
 */
export class RpcSession {
  readonly key: string;
  private readonly proc: RuntimeProcess;
  private readonly writer: JsonlWriter;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrLines: string[] = [];
  private readonly requestTimeoutMs: number;
  private requestId = 0;
  private dead = false;
  private promptInFlight = false;
  private agentEnd: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private onEvent: ((event: TurnEvent) => void) | null = null;
  /**
   * Resolved display names for in-flight tool calls (see resolveToolName).
   */
  private readonly toolNames = new Map<string, string>();

  constructor(key: string, proc: RuntimeProcess, opts: RpcSessionOptions = {}) {
    this.key = key;
    this.proc = proc;
    this.writer = new JsonlWriter(proc.stdin);
    this.logger = opts.logger ?? silentLogger();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

    proc.exited.then(
      ({ code, signal }) => this.markDead(`pi process exited: code=${code} signal=${signal}`),
      (err: unknown) =>
        this.markDead(`Worker process error: ${err instanceof Error ? err.message : String(err)}`),
    );
    this.readStdout();
    this.readStderr();
  }

  /**
   * False once the process has exited or the read loop declared it dead.
   */
  isAlive(): boolean {
    return !this.dead;
  }

  /**
   * Recent stderr output, for diagnostics when the process dies early.
   */
  stderrTail(): string {
    return this.stderrLines.join(" ").trim();
  }

  /**
   * Send a prompt to the agent and await the reply.
   *
   * Flow: prompt → preflight response → agent runs (events forwarded via opts.onEvent) → agent_end
   * event → get_last_assistant_text → data.text
   */
  async prompt(text: string, opts: PromptOptions = {}): Promise<string> {
    if (this.promptInFlight) {
      throw new Error(`Session ${this.key} already has a prompt in flight`);
    }
    this.promptInFlight = true;
    this.onEvent = opts.onEvent ?? null;

    try {
      // Register the agent_end waiter before sending, so a fast completion
      // can't slip past between the preflight response and the await.
      const { promise: done, resolve, reject } = Promise.withResolvers<void>();
      // If the preflight fails, `done` is never awaited — register a handler
      // so a rejection from markDead doesn't surface as unhandled.
      done.catch(() => {});
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            // The turn is still running inside pi — abort it, or the next
            // prompt would overlap it and be resolved by its agent_end.
            this.request("abort").catch(() => {});
            reject(new Error(`Prompt timed out after ${opts.timeoutMs! / 1000}s`));
          }, opts.timeoutMs)
        : null;
      this.agentEnd = { resolve, reject };

      try {
        await this.request("prompt", { message: text }, opts.timeoutMs);
        await done;
      } finally {
        if (timer) clearTimeout(timer);
        this.agentEnd = null;
      }

      const resp = await this.request("get_last_assistant_text");
      const data = resp.data as { text?: string | null } | undefined;
      return data?.text || "(no text response)";
    } finally {
      this.promptInFlight = false;
      this.onEvent = null;
      this.toolNames.clear(); // aborted calls may never see tool_execution_end
    }
  }

  /**
   * Ask pi to abort the in-flight turn (fire-and-forget).
   */
  abortTurn(): void {
    this.request("abort").catch(() => {});
  }

  /**
   * Total context tokens used, or null when unknown/unavailable.
   *
   * RPC stats shape: { tokens: { input, output, cacheRead, cacheWrite, total }, cost, ... }
   */
  async stats(): Promise<number | null> {
    try {
      const resp = await this.request("get_session_stats", {}, 5000);
      const data = resp.data as { tokens?: { total?: number } } | undefined;
      return data?.tokens?.total ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Kill the subprocess. The provider owns SIGTERM/SIGKILL escalation.
   */
  async kill(): Promise<void> {
    await this.proc.kill();
  }

  /**
   * Send a request and await its correlated response.
   */
  private request(
    type: string,
    params: JsonObject = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<JsonObject> {
    if (this.dead) {
      return Promise.reject(new Error(`Session ${this.key} is dead`));
    }

    const id = `req_${++this.requestId}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write({ type, id, ...params });
    });
  }

  /**
   * Read JSONL messages from stdout for the life of the process.
   */
  private readStdout(): void {
    (async () => {
      try {
        for await (const msg of parseJsonl(this.proc.stdout)) this.handleMessage(msg);
      } catch (err) {
        this.logger.error("read loop error", {
          key: this.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  /**
   * Keep a short stderr tail for diagnostics (e.g. spawn failures).
   */
  private readStderr(): void {
    (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of this.proc.stderr) {
          const text = decoder.decode(chunk, { stream: true }).trim();
          if (!text) continue;
          this.logger.log("worker stderr", { key: this.key, text });
          this.stderrLines.push(text);
          if (this.stderrLines.length > 5) this.stderrLines.shift();
        }
      } catch {
        // stderr closing is uninteresting; death is handled via proc.exited
      }
    })();
  }

  private emit(event: TurnEvent): void {
    this.onEvent?.(event);
  }

  /**
   * Bridge tools called through pi-mcp-adapter's proxy tool are reported as toolName "mcp" with the
   * real tool name in args.tool — surface that name so Turn.events consumers (live chat status)
   * don't show "⚙️ mcp…". (Direct-registered adapter tools already carry a useful prefixed name.)
   */
  private resolveToolName(msg: JsonObject): string {
    const name = String(msg.toolName ?? "?");
    if (name !== "mcp") return name;
    const args = msg.args as { tool?: unknown } | undefined;
    return typeof args?.tool === "string" && args.tool ? args.tool : name;
  }

  /**
   * Dispatch one stdout message: responses, agent_end, live progress events.
   */
  private handleMessage(msg: JsonObject): void {
    // Responses correlate to a pending request by id
    if (msg.type === "response") {
      const req = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
      if (!req) return;
      this.pending.delete(msg.id as string);
      clearTimeout(req.timer);
      if (msg.success) {
        req.resolve(msg);
      } else {
        req.reject(new Error(`${msg.command} failed: ${msg.error}`));
      }
      return;
    }

    // agent_end signals a running prompt has finished
    if (msg.type === "agent_end") {
      this.agentEnd?.resolve();
      this.agentEnd = null;
      return;
    }

    if (msg.type === "parse_error") {
      this.logger.warning(`stdout parse error: ${msg.error}`, { key: this.key });
      return;
    }

    // Live progress — surfaced as TurnEvents (and logged, so running turns
    // stay observable in the server logs).
    if (msg.type === "tool_execution_start") {
      const toolCallId = String(msg.toolCallId ?? "");
      const tool = this.resolveToolName(msg);
      if (toolCallId) this.toolNames.set(toolCallId, tool);
      this.logger.log("tool start", { key: this.key, tool, toolCallId });
      this.emit({ type: "tool_start", tool, toolCallId });
      return;
    }

    if (msg.type === "tool_execution_end") {
      const toolCallId = String(msg.toolCallId ?? "");
      const tool = this.toolNames.get(toolCallId) ?? String(msg.toolName ?? "?");
      this.toolNames.delete(toolCallId);
      const isError = Boolean(msg.isError);
      this.logger.log("tool done", { key: this.key, tool, error: isError ? "yes" : "no" });
      this.emit({ type: "tool_end", tool, toolCallId, isError });
      return;
    }

    // Streamed assistant text (token deltas).
    if (msg.type === "message_update") {
      const inner = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        this.emit({ type: "text", text: inner.delta });
      }
      return;
    }

    // pi's turn_start/turn_end fire per agent-loop iteration (several per
    // prompt when tools run); the framework Turn brackets the whole prompt, so
    // the session runtime emits those. Log for observability only. All
    // other streaming events (auto_retry_*, compaction_*,
    // extension_ui_request, …) are ignored.
    if (msg.type === "turn_start" || msg.type === "turn_end") {
      this.logger.log(msg.type === "turn_start" ? "turn start" : "turn end", {
        key: this.key,
        turn: Number(msg.turnIndex ?? 0),
      });
    }
  }

  /**
   * Declare the worker dead: kill the process, settle every waiter.
   */
  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.writer.markClosed();
    this.logger.error("worker dead", { key: this.key, reason });

    // markDead can fire while the process is still alive — the proc.exited
    // rejection path reports a worker error without a confirmed exit. Make
    // sure it's gone, or the runtime would respawn a second pi into the same
    // session directory. Harmless if already dead.
    this.proc.kill().catch(() => {});

    const err = new Error(reason);
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();

    this.agentEnd?.reject(err);
    this.agentEnd = null;
  }
}
