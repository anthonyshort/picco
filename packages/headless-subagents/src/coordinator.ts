import { randomUUID } from "node:crypto";
import type {
  AgentSessionEvent,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  AgentRecordSchema,
  DiagnosticEventSchema,
  type Failure,
  SpawnSchema,
  type AgentOwner,
  type AgentRecord,
  type ChildRunner,
  type CreateChildRunner,
  type DiagnosticEvent,
  type SpawnInput,
  type SubagentSettings,
} from "./types.js";
import type { ManifestStore } from "./manifest.js";
import { classifyFailure } from "./failure.js";

const PROGRESS_INTERVAL_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_RESULT_CHARACTERS = 64_000;
const MAX_CACHED_RESULTS = 128;

/**
 * A coordinator owns one root's entire descendant tree, including startup and cleanup capacity.
 */
export interface CoordinatorOptions<Context = ExtensionToolContext> {
  rootSessionId: string;
  settings: SubagentSettings;
  store: ManifestStore;
  createRunner: CreateChildRunner<Context>;
  toolsFor(ownerId: string | null): ToolDefinition[];
  onDiagnostic?(event: DiagnosticEvent): void;
}

/**
 * Live resources are separate from the durable metadata retained after settlement.
 */
type AgentOutcome = Exclude<AgentRecord["status"], "starting" | "running">;
type StopOutcome = Exclude<AgentOutcome, "completed">;

interface ActiveAgent {
  record: AgentRecord;
  controller: AbortController;
  runner?: ChildRunner;
  done: Promise<void>;
  resolve(): void;
  output?: string;
  requestedStatus?: StopOutcome;
  executionSettled?: boolean;
  failure?: Failure;
  error?: string;
  lastEvent: string;
  lastEventAt: number;
  toolStarts: Map<string, number>;
}

/**
 * Task delegation with shared limits, scoped control and persistent all-depth observations.
 */
export class SubagentCoordinator<Context = ExtensionToolContext> {
  private readonly opts: CoordinatorOptions<Context>;
  private readonly records = new Map<string, AgentRecord>();
  private readonly agents = new Map<string, ActiveAgent>();
  private readonly active = new Set<string>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(opts: CoordinatorOptions<Context>) {
    this.opts = opts;
  }

  /**
   * Admit synchronously and persist identity before any asynchronous SDK startup can run.
   */
  spawn(owner: AgentOwner<Context>, value: SpawnInput): AgentRecord {
    if (this.closed) throw new Error("Subagent coordinator is closed");
    const input = SpawnSchema.parse(value);
    const parent = owner.id === null ? undefined : this.records.get(owner.id);
    if (
      owner.id !== null &&
      (!parent ||
        !this.active.has(owner.id) ||
        parent.status !== "running" ||
        this.agents.get(owner.id)?.controller.signal.aborted ||
        this.agents.get(owner.id)?.executionSettled)
    ) {
      throw new Error("The owning agent is no longer running");
    }
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > this.opts.settings.maxDepth)
      throw new Error(`Subagent depth limit reached (${this.opts.settings.maxDepth})`);
    if (this.active.size >= this.opts.settings.maxActive)
      throw new Error(
        `Subagent capacity reached (${this.opts.settings.maxActive}); collect or stop existing children first`,
      );
    const timeoutMs = input.timeoutMs ?? this.opts.settings.timeoutMs;
    const maxTurns = input.maxTurns ?? this.opts.settings.maxTurns;
    if (timeoutMs > this.opts.settings.timeoutMs || maxTurns > this.opts.settings.maxTurns) {
      throw new Error("Per-call limits may only tighten the configured timeout and turn limits");
    }
    const id = randomUUID();
    const record = AgentRecordSchema.parse({
      id,
      rootSessionId: this.opts.rootSessionId,
      executionId: this.opts.store.executionId,
      parentAgentId: owner.id,
      depth,
      label: input.label,
      status: "starting",
      requestedModel: input.model ?? owner.model,
      requestedThinking: input.thinking ?? owner.thinking,
      createdAt: new Date().toISOString(),
      timeoutMs,
      maxTurns,
      turns: 0,
      toolUses: 0,
      transcriptPath: null,
    });
    const completion = Promise.withResolvers<void>();
    const agent: ActiveAgent = {
      record,
      controller: new AbortController(),
      done: completion.promise,
      resolve: completion.resolve,
      lastEvent: "starting",
      lastEventAt: Date.now(),
      toolStarts: new Map(),
    };
    let transcriptDirectory: string;
    try {
      this.opts.store.create(record);
      transcriptDirectory = this.opts.store.pathsFor(id).transcriptDirectory;
    } catch (err) {
      this.emit(agent, "persistence.failed", { category: "persistence", phase: "persistence" });
      throw err;
    }
    this.records.set(id, record);
    this.agents.set(id, agent);
    this.active.add(id);
    this.emit(agent, "agent.created", {
      depth,
      status: record.status,
      requestedModel: record.requestedModel,
      requestedThinking: record.requestedThinking,
      timeoutMs,
      maxTurns,
      manifestPath: this.opts.store.manifestPath,
    });
    void this.execute(agent, owner, input, transcriptDirectory);
    return snapshot(record);
  }

  /**
   * Result waiting is cancellable independently of the child's execution.
   */
  async result(
    ownerId: string | null,
    agentId: string,
    opts: { wait?: boolean; signal?: AbortSignal } = {},
  ) {
    const record = this.owned(ownerId, agentId);
    const agent = this.agents.get(agentId);
    if (opts.wait && agent && this.active.has(agentId)) await waitFor(agent.done, opts.signal);
    return {
      agent: snapshot(record),
      output: agent?.output,
      error: agent?.error,
      outputAvailable: agent?.output !== undefined,
    };
  }

  /**
   * Stop a direct child and its descendants, retaining admission until resource disposal settles.
   */
  async stop(ownerId: string | null, agentId: string): Promise<AgentRecord> {
    const record = this.owned(ownerId, agentId);
    this.requestStop(agentId, "cancelled");
    const agent = this.agents.get(agentId);
    if (agent) {
      try {
        await deadline(agent.done, CLEANUP_TIMEOUT_MS, "Subagent cleanup did not finish in time");
      } catch (err) {
        this.cleanupFailed(agent, err);
        throw err;
      }
    }
    return snapshot(record);
  }

  /**
   * Root callers inspect the whole tree; nested callers inspect their own descendants.
   */
  list(ownerId: string | null): AgentRecord[] {
    return [...this.records.values()]
      .filter((record) => ownerId === null || this.descendsFrom(record, ownerId))
      .map(snapshot);
  }

  /**
   * Reject new work and stop all descendants, including sessions still starting.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const id of this.active) this.requestStop(id, "cancelled");
    const settled = Promise.all([...this.active].map((id) => this.agents.get(id)!.done)).then(() =>
      this.opts.store.close(),
    );
    settled.catch(() => {});
    this.closePromise = deadline(
      settled,
      CLEANUP_TIMEOUT_MS,
      "Subagent shutdown did not finish in time",
    ).catch((err) => {
      for (const id of this.active) {
        const agent = this.agents.get(id)!;
        this.cleanupFailed(agent, err);
      }
      throw err;
    });
    return this.closePromise;
  }

  private async execute(
    agent: ActiveAgent,
    owner: AgentOwner<Context>,
    input: SpawnInput,
    transcriptDirectory: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const timeout = setTimeout(
      () => this.requestStop(agent.record.id, "timed_out"),
      agent.record.timeoutMs,
    );
    timeout.unref();
    const progress = setInterval(
      () =>
        this.emit(agent, "agent.progress", {
          status: agent.record.status,
          durationMs: Date.now() - startedAt,
          quietForMs: Date.now() - agent.lastEventAt,
          lastEvent: agent.lastEvent,
          turns: agent.record.turns,
          toolUses: agent.record.toolUses,
          activeTools: agent.toolStarts.size,
        }),
      PROGRESS_INTERVAL_MS,
    );
    progress.unref();
    let outcome: AgentOutcome = "failed";
    try {
      agent.runner = await this.opts.createRunner({
        record: snapshot(agent.record),
        owner,
        input,
        transcriptDirectory,
        signal: agent.controller.signal,
        tools: this.opts.toolsFor(agent.record.id),
        onEvent: (event) => this.onEvent(agent, event),
        onDiagnostic: (event, data) => {
          if (event === "extension.failed" && data.phase === "startup")
            agent.failure ??= { category: "extension", phase: "startup" };
          if (event === "cleanup.failed")
            agent.record.cleanupFailure ??= { category: "cleanup", phase: "cleanup" };
          if (event === "persistence.failed")
            agent.record.persistenceFailure ??= { category: "persistence", phase: "persistence" };
          this.emit(agent, event, data);
        },
        onTranscript: (path) => {
          agent.record.transcriptPath = path;
          this.persist(agent);
          this.emit(agent, "agent.transcript", {
            transcriptPath: path,
          });
        },
      });
      agent.record.model = agent.runner.model;
      agent.record.thinking = agent.runner.thinking;
      agent.record.transcriptPath = agent.runner.transcriptPath;
      if (!agent.controller.signal.aborted) {
        agent.record.status = "running";
        agent.record.startedAt = new Date().toISOString();
        this.persist(agent);
        this.emit(agent, "agent.running", {
          status: "running",
          model: agent.runner.model,
          thinking: agent.runner.thinking,
          transcriptPath: agent.runner.transcriptPath,
          depth: agent.record.depth,
        });
        const result = await waitFor(agent.runner.run(input.prompt), agent.controller.signal);
        agent.output = result.output.slice(0, MAX_RESULT_CHARACTERS);
        agent.record.truncated = result.truncated || result.output.length > MAX_RESULT_CHARACTERS;
        if (result.error) {
          agent.failure = result.failure ?? classifyFailure(result.error, "model");
          agent.error = result.error.slice(0, MAX_RESULT_CHARACTERS);
          outcome = "failed";
        } else if (result.aborted) {
          outcome = "cancelled";
        } else {
          outcome = "completed";
        }
      }
    } catch (err) {
      if (!agent.requestedStatus && !agent.record.persistenceFailure) {
        agent.failure ??= classifyFailure(err, agent.runner ? "model" : "startup");
        agent.error = (err instanceof Error ? err.message : String(err)).slice(
          0,
          MAX_RESULT_CHARACTERS,
        );
      }
    } finally {
      agent.executionSettled = true;
      clearTimeout(timeout);
      clearInterval(progress);
      for (const child of this.directChildren(agent.record.id))
        this.requestStop(child.record.id, "cancelled");
      try {
        await deadline(
          Promise.all(this.directChildren(agent.record.id).map((child) => child.done)).then(
            () => undefined,
          ),
          CLEANUP_TIMEOUT_MS,
          "Descendant cleanup did not finish in time",
        );
      } catch (err) {
        this.cleanupFailed(agent, err);
      }
      try {
        await agent.runner?.close();
      } catch (err) {
        this.cleanupFailed(agent, err);
      }
      if (agent.runner && agent.output === undefined) {
        try {
          const partial = agent.runner.currentOutput();
          agent.output = partial.slice(0, MAX_RESULT_CHARACTERS);
          agent.record.truncated = partial.length > MAX_RESULT_CHARACTERS;
        } catch (err) {
          this.cleanupFailed(agent, err);
        }
      }
      agent.runner = undefined;
      const status = agent.requestedStatus ?? outcome;
      agent.record.status = status;
      agent.record.failure = agent.failure;
      agent.record.partial =
        Boolean(agent.output) &&
        (agent.record.status !== "completed" || Boolean(agent.record.truncated));
      agent.record.endedAt = new Date().toISOString();
      agent.record.durationMs = Date.now() - startedAt;
      this.active.delete(agent.record.id);
      try {
        this.persist(agent);
      } catch {
        // The in-memory result and event still report an unavailable manifest write.
      } finally {
        this.emit(agent, `agent.${status}`, {
          status,
          durationMs: agent.record.durationMs,
          turns: agent.record.turns,
          toolUses: agent.record.toolUses,
          partial: agent.record.partial,
          truncated: Boolean(agent.record.truncated),
          ...(agent.failure ?? {}),
          ...(agent.record.transcriptPath ? { transcriptPath: agent.record.transcriptPath } : {}),
        });
        agent.resolve();
        this.evictResults();
      }
    }
  }

  private onEvent(agent: ActiveAgent, event: AgentSessionEvent): void {
    agent.lastEvent = event.type;
    agent.lastEventAt = Date.now();
    switch (event.type) {
      case "tool_execution_start":
        agent.record.toolUses++;
        agent.toolStarts.set(event.toolCallId, Date.now());
        this.emit(agent, "tool.started", { tool: event.toolName, toolCallId: event.toolCallId });
        break;
      case "tool_execution_end": {
        const start = agent.toolStarts.get(event.toolCallId);
        agent.toolStarts.delete(event.toolCallId);
        this.emit(agent, event.isError ? "tool.failed" : "tool.completed", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          ...(start !== undefined ? { durationMs: Date.now() - start } : {}),
        });
        break;
      }
      case "message_end":
        if (event.message.role === "assistant") {
          const message = event.message;
          const usage = message.usage;
          const current = agent.record.usage ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
          };
          current.input += usage.input;
          current.output += usage.output;
          current.cacheRead += usage.cacheRead;
          current.cacheWrite += usage.cacheWrite;
          current.cost += usage.cost.total;
          agent.record.usage = current;
          this.emit(agent, message.stopReason === "error" ? "model.failed" : "model.completed", {
            model: `${message.provider}/${message.model}`,
            stopReason: message.stopReason,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cost: usage.cost.total,
            ...(message.stopReason === "error"
              ? classifyFailure(message.errorMessage, "model", message.diagnostics)
              : {}),
          });
        }
        break;
      case "turn_end":
        agent.record.turns++;
        this.emit(agent, "agent.turn", { turns: agent.record.turns });
        if (
          agent.record.turns >= agent.record.maxTurns &&
          event.message.role === "assistant" &&
          event.message.stopReason === "toolUse"
        ) {
          this.requestStop(agent.record.id, "limit_reached");
        }
        break;
      case "compaction_start":
        this.emit(agent, "compaction.started", { reason: event.reason });
        break;
      case "compaction_end":
        this.emit(agent, event.errorMessage ? "compaction.failed" : "compaction.completed", {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(event.errorMessage ? classifyFailure(event.errorMessage, "compaction") : {}),
        });
        break;
      case "auto_retry_start":
        this.emit(agent, "model.retry", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          ...classifyFailure(event.errorMessage, "model"),
        });
        break;
      default:
        break;
    }
  }

  private owned(ownerId: string | null, id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record || record.parentAgentId !== ownerId)
      throw new Error("Agent not found or not owned by this parent");
    return record;
  }

  private descendsFrom(record: AgentRecord, ownerId: string): boolean {
    let parent = record.parentAgentId;
    while (parent !== null) {
      if (parent === ownerId) return true;
      parent = this.records.get(parent)?.parentAgentId ?? null;
    }
    return false;
  }

  private directChildren(ownerId: string): ActiveAgent[] {
    return [...this.active]
      .map((id) => this.agents.get(id)!)
      .filter((agent) => agent.record.parentAgentId === ownerId);
  }

  private requestStop(id: string, status: StopOutcome): void {
    const agent = this.agents.get(id);
    if (!agent || !this.active.has(id) || agent.executionSettled) return;
    if (agent.requestedStatus) return;
    agent.requestedStatus = status;
    this.emit(agent, "agent.cancellation_requested", {
      reason: status,
      status: agent.record.status,
    });
    agent.controller.abort();
    for (const child of this.directChildren(id)) this.requestStop(child.record.id, "cancelled");
    void Promise.resolve()
      .then(() => agent.runner?.abort())
      .catch((err) => this.cleanupFailed(agent, err));
  }

  private persist(agent: ActiveAgent): void {
    try {
      this.opts.store.update(snapshot(agent.record));
    } catch (err) {
      agent.record.persistenceFailure = { category: "persistence", phase: "persistence" };
      this.emit(agent, "persistence.failed", agent.record.persistenceFailure);
      throw err;
    }
  }

  private cleanupFailed(agent: ActiveAgent, value: unknown): void {
    agent.record.cleanupFailure ??= { ...classifyFailure(value, "cleanup"), category: "cleanup" };
    this.emit(agent, "cleanup.failed", agent.record.cleanupFailure);
  }

  private emit(
    agent: ActiveAgent,
    event: DiagnosticEvent["event"],
    data: DiagnosticEvent["data"],
  ): void {
    try {
      this.opts.onDiagnostic?.(
        DiagnosticEventSchema.parse({
          version: 1,
          at: new Date().toISOString(),
          rootSessionId: this.opts.rootSessionId,
          executionId: this.opts.store.executionId,
          agentId: agent.record.id,
          parentAgentId: agent.record.parentAgentId,
          event,
          data,
        }),
      );
    } catch {
      // Observation is best effort and never changes execution outcomes.
    }
  }

  private evictResults(): void {
    if (this.agents.size <= MAX_CACHED_RESULTS) return;
    for (const [id] of this.agents) {
      if (!this.active.has(id)) this.agents.delete(id);
      if (this.agents.size <= MAX_CACHED_RESULTS) break;
    }
  }
}

/**
 * Return metadata copies so callers cannot mutate coordinator-owned identity or state.
 */
function snapshot(record: AgentRecord): AgentRecord {
  return AgentRecordSchema.parse(record);
}

/**
 * Aborting a wait does not propagate cancellation into the promise being observed.
 */
async function waitFor<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("Agent result wait cancelled");
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(new Error("Agent result wait cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * A misbehaving SDK extension cannot keep a host's shutdown hook pending indefinitely.
 */
async function deadline(
  promise: Promise<void>,
  milliseconds: number,
  message: string,
): Promise<void> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(message)), milliseconds);
  try {
    await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}
