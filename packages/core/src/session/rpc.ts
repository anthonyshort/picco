import { ExecutionError } from "./execution.js";
import type { ExecutionWork } from "./work.js";
import * as z from "zod";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { parseJsonl, JsonlWriter, type JsonObject } from "./jsonl.js";
import { silentLogger } from "../utils/logger.js";
import type { Logger, RuntimeProcess } from "../types.js";
import type { TurnEvent } from "./turn.js";

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Only terminal assistant metadata is needed to reject provider failures safely.
 */
const AssistantEndSchema = z.object({
  type: z.literal("message_end"),
  message: z.object({ role: z.literal("assistant"), stopReason: z.string() }),
});

/**
 * Structured pi-subagents tool metadata exposed by Pi's existing RPC events.
 */
const SubagentArgsSchema = z.object({
  subagent_type: z.string().optional(),
  model: z.string().optional(),
});
const SubagentResultSchema = z.object({
  details: z
    .object({
      agentId: z.string().optional(),
      modelName: z.string().optional(),
      status: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .max(100)
    .optional(),
});

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
  /**
   * Execution holds and unbuffered worker observers.
   */
  work?: ExecutionWork;
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
  private promptFailure: Error | undefined;
  private reloadFailure: Error | undefined;
  private reloading = false;
  private executionReady: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private onEvent: ((event: TurnEvent) => void) | null = null;
  private work?: ExecutionWork;
  private rejectPrompt?: (err: Error) => void;

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
   * Flow: prompt → preflight response → agent runs (events forwarded via opts.onEvent) →
   * agent_settled event → get_last_assistant_text → data.text
   */
  async prompt(text: string, opts: PromptOptions = {}): Promise<string> {
    if (this.promptInFlight) {
      throw new Error(`Session ${this.key} already has a prompt in flight`);
    }
    this.promptInFlight = true;
    this.promptFailure = undefined;
    this.onEvent = opts.onEvent ?? null;

    this.work = opts.work;
    const failure = Promise.withResolvers<never>();
    failure.promise.catch(() => {});
    this.rejectPrompt = failure.reject;
    const deadline = opts.timeoutMs
      ? setTimeout(() => {
          this.abortTurn();
          this.rejectPrompt?.(
            new ExecutionError("timeout", `Prompt timed out after ${opts.timeoutMs! / 1000}s`),
          );
        }, opts.timeoutMs)
      : undefined;
    try {
      const wait = () => {
        const pending = Promise.withResolvers<void>();
        pending.promise.catch(() => {});
        this.executionReady = pending;
        return pending.promise;
      };
      let ready = wait();
      if (this.work) {
        this.work.onChange = () => this.checkReadiness();
      }
      const response = await Promise.race([
        this.request({ type: "prompt", message: text }, opts.timeoutMs),
        failure.promise,
      ]);
      switch (response.data.disposition) {
        case "handled":
          if (this.work) {
            this.work.settleWorker();
          } else {
            this.executionReady?.resolve();
          }
          break;
        case "started":
        case "queued":
          break;
        default:
          throw new Error(`Unknown prompt disposition: ${response.data.disposition}`);
      }
      while (true) {
        await Promise.race([ready, failure.promise]);
        if (this.promptFailure) {
          throw this.promptFailure;
        }
        if (response.data.disposition === "handled") {
          if (!this.work || this.work.ready()) {
            return "";
          }
          ready = wait();
          this.checkReadiness();
          continue;
        }
        const version = this.work?.version;
        const resp = await Promise.race([
          this.request({ type: "get_last_assistant_text" }),
          failure.promise,
        ]);
        if (!this.work || (this.work.ready() && version === this.work.version)) {
          return resp.data.text || "(no text response)";
        }
        ready = wait();
        this.checkReadiness();
      }
    } finally {
      if (deadline) {
        clearTimeout(deadline);
      }
      this.executionReady = null;
      this.promptInFlight = false;
      this.onEvent = null;
      if (this.work) {
        this.work.onChange = undefined;
      }
      this.work = undefined;
      this.rejectPrompt = undefined;
    }
  }

  /**
   * Execute the bundled reload command only after verifying that it is registered.
   */
  async reload(): Promise<void> {
    if (this.promptInFlight) throw new Error("Cannot reload during a prompt");
    const catalogue = await this.request({ type: "get_commands" });
    if (!catalogue.data.commands.some((command) => command.name === "picco-reload")) {
      throw new Error("The Picco reload command is unavailable in this worker");
    }
    this.reloadFailure = undefined;
    this.reloading = true;
    try {
      const response = await this.request({ type: "prompt", message: "/picco-reload" }, 30_000);
      if (response.data.disposition !== "handled") {
        this.abortTurn();
        throw new Error("Reload was not handled as a session command");
      }
      if (this.reloadFailure) throw this.reloadFailure;
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Ask pi to abort the in-flight turn (fire-and-forget).
   */
  abortTurn(): void {
    this.request({ type: "abort" }).catch(() => {});
  }

  /**
   * Total context tokens used, or null when unknown/unavailable.
   *
   * RPC stats shape: { tokens: { input, output, cacheRead, cacheWrite, total }, cost, ... }
   */
  async stats(): Promise<number | null> {
    try {
      const resp = await this.request({ type: "get_session_stats" }, 5000);
      return resp.data.tokens.total ?? null;
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
  private request<Type extends RpcCommand["type"]>(
    command: Extract<RpcCommand, { type: Type }>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Extract<RpcResponse, { command: Type; success: true }>> {
    if (this.dead) {
      return Promise.reject(new Error(`Session ${this.key} is dead`));
    }

    const id = `req_${++this.requestId}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command.type} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write({ ...command, id });
    }).then((response) => response as Extract<RpcResponse, { command: Type; success: true }>);
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
   * Wake the prompt when execution work is ready, or reject a failed hold.
   */
  private checkReadiness(): void {
    try {
      if (this.work?.ready()) {
        this.executionReady?.resolve();
      }
    } catch (err) {
      this.rejectPrompt?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private observeWorker(msg: JsonObject): void {
    if (!this.work) {
      return;
    }
    if (msg.type === "agent_start" || msg.type === "agent_settled") {
      this.work.emit({ type: msg.type });
    } else if (
      msg.type === "tool_execution_start" &&
      typeof msg.toolName === "string" &&
      typeof msg.toolCallId === "string"
    ) {
      this.work.emit({
        type: "tool_start",
        tool: msg.toolName,
        toolCallId: msg.toolCallId,
        args: msg.args,
      });
    } else if (
      msg.type === "tool_execution_end" &&
      typeof msg.toolName === "string" &&
      typeof msg.toolCallId === "string"
    ) {
      this.work.emit({
        type: "tool_end",
        tool: msg.toolName,
        toolCallId: msg.toolCallId,
        isError: Boolean(msg.isError),
        result: msg.result,
      });
    } else if (msg.type === "message_end") {
      const custom = z
        .object({ role: z.literal("custom"), customType: z.string(), details: z.unknown() })
        .safeParse(msg.message);
      if (custom.success) {
        this.work.emit({
          type: "custom_message",
          customType: custom.data.customType,
          details: custom.data.details,
        });
      }
    }
  }

  /**
   * Dispatch one stdout message: responses, agent_settled, live progress events.
   */
  private handleMessage(msg: JsonObject): void {
    try {
      this.observeWorker(msg);
    } catch (err) {
      this.rejectPrompt?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const ended = AssistantEndSchema.safeParse(msg);
    if (ended.success && this.promptInFlight) {
      switch (ended.data.message.stopReason) {
        case "error":
          this.promptFailure = new Error(
            "Model provider request failed; inspect session diagnostics.",
          );
          break;
        case "aborted":
          this.promptFailure = new ExecutionError("cancelled", "Model request was aborted.");
          break;
        default:
          this.promptFailure = undefined;
      }
    }
    if (
      msg.type === "extension_error" &&
      this.reloading &&
      msg.extensionPath === "command:picco-reload"
    ) {
      this.reloadFailure = new Error("Pi resource reload failed; inspect session diagnostics.");
    }
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

    // agent_settled signals a running prompt has finished
    if (msg.type === "agent_settled") {
      if (this.promptFailure) {
        this.rejectPrompt?.(this.promptFailure);
      } else if (!this.work) {
        this.executionReady?.resolve();
      }
      return;
    }

    if (msg.type === "extension_ui_request") {
      switch (msg.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          this.writer.write({ type: "extension_ui_response", id: msg.id, cancelled: true });
          break;
        case "notify":
          this.logger.log("extension notification", { key: this.key, message: msg.message });
          break;
      }
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
      const tool = String(msg.toolName ?? "?");
      this.logger.log("tool start", { key: this.key, tool, toolCallId });
      if (tool === "Agent") {
        const args = SubagentArgsSchema.safeParse(msg.args);
        this.logger.log("subagent start", {
          key: this.key,
          toolCallId,
          subagentType: args.data?.subagent_type,
          requestedModel: args.data?.model,
        });
      }
      this.emit({ type: "tool_start", tool, toolCallId });
      return;
    }

    if (msg.type === "tool_execution_end") {
      const toolCallId = String(msg.toolCallId ?? "");
      const tool = String(msg.toolName ?? "?");
      const isError = Boolean(msg.isError);
      this.logger.log("tool done", { key: this.key, tool, error: isError ? "yes" : "no" });
      if (tool === "Agent") this.logSubagentResult(toolCallId, msg.result, isError);
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
    // other streaming events (auto_retry_*, compaction_*, …) are ignored.
    if (msg.type === "turn_start" || msg.type === "turn_end") {
      this.logger.log(msg.type === "turn_start" ? "turn start" : "turn end", {
        key: this.key,
        turn: Number(msg.turnIndex ?? 0),
      });
    }
  }

  /**
   * A subagent can fail while the outer Agent tool succeeds; use its reported status and error.
   */
  private logSubagentResult(toolCallId: string, result: unknown, isError: boolean): void {
    const parsed = SubagentResultSchema.safeParse(result);
    const details = parsed.data?.details;
    const fields = { key: this.key, toolCallId, ...details };
    if (isError || details?.status === "error" || details?.error) {
      const error =
        details?.error ??
        parsed.data?.content
          ?.filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n");
      this.logger.error("subagent failed", { ...fields, error });
    } else {
      this.logger.log("subagent result", fields);
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

    const err = new ExecutionError("worker", reason);
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();

    this.rejectPrompt?.(err);
    this.executionReady?.reject(err);
    this.executionReady = null;
  }
}
