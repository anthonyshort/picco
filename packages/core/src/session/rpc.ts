import { randomUUID } from "node:crypto";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { parseJsonl, JsonlWriter, type JsonObject } from "./jsonl.js";
import { readSubagentDiagnostic } from "./subagent-diagnostics.js";
import { classifyFailure, type Failure } from "./failure.js";
import { scopeLogger, silentLogger } from "../utils/logger.js";
import type { Logger, RuntimeProcess } from "../types.js";
import type { TurnEvent } from "./turn.js";

const REQUEST_TIMEOUT_MS = 10_000;
const SUBAGENT_PROGRESS_INTERVAL_MS = 10_000;
const PROGRESS_INTERVAL_MS = 30_000;
const MAX_AGENT_ORIGINS = 10_000;
const MAX_STDERR_CHARS = 4096;
const EXPECTED_STOP_EXIT_CODES = new Set([0, 143]);
const LabelSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\r\n\t]+$/);
const ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "entry_appended",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
  "extension_error",
]);
const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  stopReason: z.string(),
  errorMessage: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  diagnostics: z.unknown().optional(),
});
const ExtensionHookSchema = z.enum([
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_call",
  "tool_result",
  "session_before_compact",
  "session_compact",
]);
const ExtensionPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\t]+$/);
const StateSchema = z.object({
  sessionId: LabelSchema,
  sessionFile: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\t]+$/)
    .optional(),
});
const STOP_REASONS = [
  "idle_eviction",
  "reset",
  "one_shot_completed",
  "host_shutdown",
  "turn_failed",
  "timeout",
  "cancelled",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Carry selected failure evidence while preserving the caller's existing Error message.
 */
export class RpcOperationError extends Error {
  constructor(
    message: string,
    readonly failure: Failure,
    readonly rpcCommand?: RpcCommand["type"],
  ) {
    super(message);
  }
}

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
  workerId?: string;
}

export interface PromptOptions {
  timeoutMs?: number;
  requestId?: string;
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
  private readonly activeTools = new Map<string, number>();
  private readonly subagentProgressAt = new Map<string, number>();
  private readonly agentOrigins = new Map<string, string>();
  private lastEventAt = 0;
  private lastEventType = "none";
  private modelStopReason: string | null = null;
  private modelFailure?: Failure;
  private requestCancelled = false;
  private compactionStartedAt: number | null = null;
  private commandId = 0;
  private dead = false;
  private stopReason?: StopReason;
  private promptInFlight = false;
  private activeRequestId?: string;
  private piSessionId?: string;
  private transcriptPath?: string;
  private agentSettled: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private onEvent: ((event: TurnEvent) => void) | null = null;

  constructor(key: string, proc: RuntimeProcess, opts: RpcSessionOptions = {}) {
    this.key = key;
    this.proc = proc;
    this.writer = new JsonlWriter(proc.stdin);
    this.logger = scopeLogger(opts.logger ?? silentLogger(), {
      key,
      workerId: opts.workerId ?? randomUUID(),
    });
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    proc.exited.then(
      ({ code, signal }) => this.markDead(code, signal),
      () =>
        this.markDead(null, null, {
          category: "runtime",
          phase: this.promptInFlight ? "model" : "startup",
        }),
    );
    this.readStdout();
    this.readStderr();
  }

  isAlive(): boolean {
    return !this.dead;
  }

  /**
   * Private startup evidence; never automatically copied to operational logs.
   */
  stderrTail(): string {
    return this.stderrLines.join(" ").trim();
  }

  /**
   * Read native identity through the supported RPC state command.
   */
  async refreshState(): Promise<void> {
    this.piSessionId = undefined;
    this.transcriptPath = undefined;
    try {
      const response = await this.request({ type: "get_state" });
      const state = StateSchema.safeParse(response.data);
      if (!state.success) return;
      this.piSessionId = state.data.sessionId;
      this.transcriptPath = state.data.sessionFile;
      this.logger.log("worker.state", this.context());
    } catch {
      this.logger.warning("worker.state_unavailable", { ...this.context(), category: "protocol" });
    }
  }

  /**
   * Send a prompt and preserve the existing public text/rejection contract.
   */
  async prompt(text: string, opts: PromptOptions = {}): Promise<string> {
    if (this.promptInFlight) throw new Error(`Session ${this.key} already has a prompt in flight`);
    this.promptInFlight = true;
    this.activeRequestId = opts.requestId ?? randomUUID();
    this.onEvent = opts.onEvent ?? null;
    const startedAt = Date.now();
    this.lastEventAt = startedAt;
    this.lastEventType = "none";
    this.activeTools.clear();
    this.modelStopReason = null;
    this.modelFailure = undefined;
    this.requestCancelled = false;
    let outcome = "failed";
    this.logger.log("request.started", { ...this.context(), timeoutMs: opts.timeoutMs });
    const progressTimer = setInterval(
      () => this.logger.log("request.progress", this.progressData(startedAt)),
      PROGRESS_INTERVAL_MS,
    );
    progressTimer.unref();
    try {
      const { promise: done, resolve, reject } = Promise.withResolvers<void>();
      done.catch(() => {});
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            this.logger.warning("request.timeout", {
              ...this.context(),
              timeoutMs: opts.timeoutMs,
            });
            this.request({ type: "abort" }).catch(() => {});
            reject(
              new RpcOperationError(`Prompt timed out after ${opts.timeoutMs! / 1000}s`, {
                category: "timeout",
                phase: "model",
              }),
            );
          }, opts.timeoutMs)
        : null;
      this.agentSettled = { resolve, reject };
      try {
        const response = await this.request({ type: "prompt", message: text }, opts.timeoutMs);
        switch (response.data.disposition) {
          case "handled":
            await this.refreshState();
            outcome = "handled";
            return "";
          case "started":
          case "queued":
            await done;
            break;
          default:
            throw new Error(`Unknown prompt disposition: ${response.data.disposition}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.agentSettled = null;
      }
      const response = await this.request({ type: "get_last_assistant_text" });
      outcome =
        this.modelStopReason === "error"
          ? "model_failed"
          : this.requestCancelled || this.modelStopReason === "aborted"
            ? "cancelled"
            : this.modelStopReason === "length"
              ? "output_limited"
              : "completed";
      return response.data.text || "(no text response)";
    } catch (err) {
      const failure =
        err instanceof RpcOperationError ? err.failure : classifyFailure(err, "model");
      outcome =
        failure.category === "timeout"
          ? "timed_out"
          : failure.category === "cancelled"
            ? "cancelled"
            : "failed";
      if (!this.dead)
        this.logger.error("request.failed", {
          ...this.context(),
          ...failure,
          ...(err instanceof RpcOperationError && err.rpcCommand
            ? { rpcCommand: err.rpcCommand }
            : {}),
        });
      throw err;
    } finally {
      clearInterval(progressTimer);
      this.logger.log("request.finished", {
        ...this.context(),
        outcome,
        ...(outcome === "model_failed" || outcome === "output_limited" ? this.modelFailure : {}),
        durationMs: Date.now() - startedAt,
      });
      this.activeTools.clear();
      this.promptInFlight = false;
      this.activeRequestId = undefined;
      this.onEvent = null;
    }
  }

  abortTurn(requestId?: string): void {
    this.requestCancelled = this.promptInFlight;
    this.logger.log("request.cancel_forwarded", {
      ...this.context(),
      ...(requestId ? { targetRequestId: requestId } : {}),
      inFlight: this.promptInFlight,
    });
    this.request({ type: "abort" }).catch(() => {});
  }

  async stats(): Promise<number | null> {
    try {
      return (await this.request({ type: "get_session_stats" }, 5000)).data.tokens.total ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Record intent before signalling; failed or already-finished workers remain unexpected.
   */
  async kill(reason: StopReason = "host_shutdown"): Promise<void> {
    if (this.proc.alive && !this.dead) {
      this.stopReason ??= reason;
      this.logger.log("worker.stop_requested", {
        ...this.context(),
        reason,
        inFlight: this.promptInFlight,
      });
    }
    try {
      await this.proc.kill();
    } catch (err) {
      this.stopReason = undefined;
      throw err;
    }
  }

  private request<Type extends RpcCommand["type"]>(
    command: Extract<RpcCommand, { type: Type }>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Extract<RpcResponse, { command: Type; success: true }>> {
    if (this.dead) return Promise.reject(new Error(`Session ${this.key} is dead`));
    const id = `req_${++this.commandId}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcOperationError(
            `${command.type} timed out after ${timeoutMs / 1000}s`,
            { category: "timeout", phase: "protocol" },
            command.type,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write({ ...command, id });
    }).then((response) => response as Extract<RpcResponse, { command: Type; success: true }>);
  }

  private readStdout(): void {
    (async () => {
      try {
        for await (const msg of parseJsonl(this.proc.stdout)) this.handleMessage(msg);
      } catch {
        this.markDead(null, null, { category: "protocol", phase: "protocol" });
      }
    })();
  }

  private readStderr(): void {
    (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of this.proc.stderr) {
          const text = decoder.decode(chunk, { stream: true }).trim();
          if (!text) continue;
          this.stderrLines.push(text.slice(0, MAX_STDERR_CHARS));
          if (this.stderrLines.length > 5) this.stderrLines.shift();
        }
      } catch {
        /* Process termination owns stream closure. */
      }
    })();
  }

  private context(): Record<string, unknown> {
    return {
      ...(this.activeRequestId ? { requestId: this.activeRequestId } : {}),
      ...(this.piSessionId ? { piSessionId: this.piSessionId } : {}),
      ...(this.transcriptPath ? { transcriptPath: this.transcriptPath } : {}),
    };
  }

  private progressData(startedAt: number) {
    return {
      ...this.context(),
      durationMs: Date.now() - startedAt,
      quietForMs: Date.now() - this.lastEventAt,
      lastEvent: this.lastEventType,
      activeTools: this.activeTools.size,
    };
  }

  private emit(event: TurnEvent): void {
    this.onEvent?.(event);
  }

  private handleMessage(msg: JsonObject): void {
    if (msg.type !== "response") {
      this.lastEventAt = Date.now();
      this.lastEventType =
        typeof msg.type === "string" && ACTIVITY_EVENTS.has(msg.type) ? msg.type : "other";
    }
    const diagnostic = readSubagentDiagnostic(msg);
    if (diagnostic) {
      const id = `${diagnostic.data.executionId}/${diagnostic.data.agentId}`;
      if (!this.agentOrigins.has(id)) {
        const parentId = diagnostic.data.parentAgentId;
        const origin =
          parentId === null
            ? diagnostic.event === "agent.created"
              ? this.activeRequestId
              : undefined
            : this.agentOrigins.get(`${diagnostic.data.executionId}/${parentId}`);
        if (origin && this.agentOrigins.size < MAX_AGENT_ORIGINS) this.agentOrigins.set(id, origin);
      }
      const last = this.subagentProgressAt.get(id);
      if (
        diagnostic.event !== "agent.progress" ||
        last === undefined ||
        Date.now() - last >= SUBAGENT_PROGRESS_INTERVAL_MS
      ) {
        // A background event must never inherit the currently active root request.
        const {
          requestId: activeRequestId,
          transcriptPath: rootTranscriptPath,
          piSessionId,
          ...context
        } = this.context();
        void activeRequestId;
        const origin = this.agentOrigins.get(id);
        const data = {
          ...context,
          ...(piSessionId === diagnostic.data.rootSessionId ? { piSessionId } : {}),
          ...(rootTranscriptPath && diagnostic.data.rootSessionId === piSessionId
            ? { rootTranscriptPath }
            : {}),
          ...diagnostic.data,
          ...(origin ? { requestId: origin } : {}),
        };
        if (diagnostic.isError) this.logger.error(diagnostic.event, data);
        else this.logger.log(diagnostic.event, data);
        if (diagnostic.event === "agent.progress") this.subagentProgressAt.set(id, Date.now());
      }
      if (diagnostic.terminal) this.subagentProgressAt.delete(id);
    }
    if (msg.type === "response") {
      const pending = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
      if (!pending) return;
      this.pending.delete(String(msg.id));
      clearTimeout(pending.timer);
      if (msg.success) pending.resolve(msg);
      else
        pending.reject(
          new RpcOperationError(
            `${msg.command} failed: ${msg.error}`,
            classifyFailure(msg.error, msg.command === "prompt" ? "model" : "protocol"),
          ),
        );
      return;
    }
    if (msg.type === "agent_settled") {
      this.agentSettled?.resolve();
      this.agentSettled = null;
      return;
    }
    if (msg.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(String(msg.method)))
        this.writer.write({ type: "extension_ui_response", id: msg.id, cancelled: true });
      return;
    }
    if (msg.type === "extension_error") {
      const hook = ExtensionHookSchema.safeParse(msg.event);
      const path = ExtensionPathSchema.safeParse(msg.extensionPath);
      const phase = hook.success
        ? hook.data === "session_shutdown"
          ? "cleanup"
          : hook.data === "session_start"
            ? "startup"
            : hook.data === "session_before_compact" || hook.data === "session_compact"
              ? "compaction"
              : "model"
        : undefined;
      const failure = phase ? classifyFailure(msg.error, phase) : undefined;
      this.logger.error("extension.failed", {
        ...this.context(),
        ...(path.success ? { extensionPath: path.data } : {}),
        ...(hook.success ? { hook: hook.data } : {}),
        ...(phase ? { phase } : {}),
        ...(failure && failure.category !== "unknown" ? failure : { category: "extension" }),
      });
      return;
    }
    if (msg.type === "parse_error") {
      this.logger.warning("worker.protocol_failed", { ...this.context(), category: "protocol" });
      return;
    }
    if (msg.type === "tool_execution_start" || msg.type === "tool_execution_end") {
      const toolCallId = LabelSchema.safeParse(msg.toolCallId);
      const tool = LabelSchema.safeParse(msg.toolName);
      if (!toolCallId.success || !tool.success) return;
      if (msg.type === "tool_execution_start") {
        this.activeTools.set(toolCallId.data, Date.now());
        this.logger.log("tool.started", {
          ...this.context(),
          tool: tool.data,
          toolCallId: toolCallId.data,
        });
        this.emit({ type: "tool_start", tool: tool.data, toolCallId: toolCallId.data });
      } else {
        const startedAt = this.activeTools.get(toolCallId.data);
        this.activeTools.delete(toolCallId.data);
        const isError = msg.isError === true;
        const data = {
          ...this.context(),
          tool: tool.data,
          toolCallId: toolCallId.data,
          outcome: isError ? "failed" : "completed",
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
        };
        if (isError) this.logger.warning("tool.finished", data);
        else this.logger.log("tool.finished", data);
        this.emit({ type: "tool_end", tool: tool.data, toolCallId: toolCallId.data, isError });
      }
      return;
    }
    if (msg.type === "message_end") {
      const parsed = AssistantMessageSchema.safeParse(msg.message);
      if (!parsed.success) return;
      const message = parsed.data;
      const provider = LabelSchema.safeParse(message.provider);
      const model = LabelSchema.safeParse(message.model);
      const identity = {
        ...(provider.success ? { provider: provider.data } : {}),
        ...(model.success ? { model: model.data } : {}),
      };
      this.modelStopReason = message.stopReason;
      this.modelFailure =
        message.stopReason === "error"
          ? classifyFailure(message.errorMessage, "model", message.diagnostics)
          : message.stopReason === "length"
            ? { category: "output_limit", phase: "model" }
            : undefined;
      if (message.stopReason === "error") {
        this.logger.error("model.failed", {
          ...this.context(),
          ...identity,
          ...this.modelFailure,
        });
      } else if (message.stopReason === "length") {
        this.logger.warning("model.output_limited", {
          ...this.context(),
          category: "output_limit",
          phase: "model",
          ...identity,
        });
      } else if (message.stopReason === "aborted")
        this.logger.log("model.cancelled", this.context());
      return;
    }
    if (msg.type === "auto_retry_start" || msg.type === "summarization_retry_scheduled") {
      this.logger.warning("model.retry_scheduled", {
        ...this.context(),
        attempt: finiteCount(msg.attempt),
        maxAttempts: finiteCount(msg.maxAttempts),
        delayMs: finiteCount(msg.delayMs),
        ...classifyFailure(
          msg.errorMessage,
          msg.type === "auto_retry_start" ? "model" : "compaction",
        ),
      });
      return;
    }
    if (msg.type === "auto_retry_end") {
      const data = {
        ...this.context(),
        attempt: finiteCount(msg.attempt),
        ...(msg.success === true ? {} : classifyFailure(msg.finalError, "model")),
      };
      if (msg.success === true) this.logger.log("model.recovered", data);
      else this.logger.error("model.retries_exhausted", data);
      return;
    }
    if (msg.type === "compaction_start") {
      this.compactionStartedAt = Date.now();
      this.logger.log("compaction.started", this.context());
      return;
    }
    if (msg.type === "compaction_end") {
      const outcome = msg.errorMessage ? "failed" : msg.aborted ? "cancelled" : "completed";
      const data = {
        ...this.context(),
        outcome,
        willRetry: msg.willRetry === true,
        ...(this.compactionStartedAt !== null
          ? { durationMs: Date.now() - this.compactionStartedAt }
          : {}),
        ...(msg.errorMessage ? classifyFailure(msg.errorMessage, "compaction") : {}),
      };
      this.compactionStartedAt = null;
      if (outcome === "failed") this.logger.error("compaction.finished", data);
      else this.logger.log("compaction.finished", data);
      return;
    }
    if (msg.type === "message_update") {
      const inner = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string")
        this.emit({ type: "text", text: inner.delta });
    }
  }

  /**
   * Preserve process facts separately from Picco's requested stop cause.
   */
  private markDead(code: number | null, signal: string | null, failure?: Failure): void {
    if (this.dead) return;
    this.dead = true;
    this.agentOrigins.clear();
    this.subagentProgressAt.clear();
    this.writer.markClosed();
    const expected =
      !failure &&
      this.stopReason !== undefined &&
      ((code !== null && EXPECTED_STOP_EXIT_CODES.has(code)) ||
        (code === null && (signal === "SIGTERM" || signal === "SIGKILL")));
    const data = {
      ...this.context(),
      exitCode: code,
      signal,
      expected,
      stopReason: this.stopReason ?? null,
      inFlight: this.promptInFlight,
      ...(failure ?? {}),
    };
    if (failure) this.logger.error("worker.failed", data);
    else if (expected) this.logger.log("worker.exited", data);
    else this.logger.error("worker.exited", data);
    this.proc.kill().catch(() => {});
    const reason = failure
      ? "Worker process error"
      : `pi process exited: code=${code} signal=${signal}`;
    const err = new RpcOperationError(
      reason,
      failure ?? {
        category: "runtime",
        phase: this.promptInFlight ? "model" : "startup",
      },
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.agentSettled?.reject(err);
    this.agentSettled = null;
  }
}

/**
 * Keep malformed transport counters out of operational events.
 */
function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
