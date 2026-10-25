import { randomUUID } from "node:crypto";
import {
  ExecutionFailure,
  ExecutionError,
  finaliseWithin,
  type ExecutionRef,
  type ExecutionFinalisation,
  type ExecutionOutcome,
} from "./execution.js";
import type { ReloadOperation } from "./reload.js";
import { mkdir } from "node:fs/promises";
import { RpcSession } from "./rpc.js";
import { silentLogger } from "../utils/logger.js";
import { generateSessionId } from "../utils/agent-paths.js";
import type { AgentPaths } from "../utils/agent-paths.js";
import type { Tool } from "../tools/tool.js";
import { createTurn, type Turn, type TurnController, type TurnResult } from "./turn.js";
import type {
  Logger,
  PiOptions,
  PrepareSessionInfo,
  RunOptions,
  Runtime,
  Session,
  SessionIdentity,
  SessionInfo,
  SessionOptions,
  SessionRef,
  Sessions,
  SessionStats,
  SessionToolSpec,
  SpawnRequest,
  TurnOptions,
} from "../types.js";

const DEFAULT_IDLE_TIMEOUT = false;
const DEFAULT_MAX_RUNS = 10;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;
const READY_DELAY_MS = 100; // no ready message from RPC mode — wait, then check
const SWEEP_INTERVAL_MS = 60_000;

/**
 * What setupSession hands back: the session's resolved pi config, tool manifest, and bridge token.
 */
export interface SessionSetup {
  /**
   * The kernel-resolved pi config — carried to the runtime as SpawnRequest.pi.
   */
  pi: PiOptions;
  /**
   * The complete child environment, used verbatim. When absent, the manager falls back to its base
   * env (SpawnRequest.env is otherwise empty — env is a runtime-ambient concern).
   */
  env?: Record<string, string>;
  /**
   * The host tool manifest served over the bridge — carried to the runtime as SpawnRequest.tools.
   */
  tools?: SessionToolSpec[];
  /**
   * The per-session bridge bearer token — carried to the runtime as SpawnRequest.bridge.token and
   * written to bridge.json so the bridge extension can authenticate its calls.
   */
  bridgeToken?: string;
}

/**
 * What the manager hands setupSession: the ref, cwd, and per-call spawn inputs (pi overrides,
 * per-session env, session-scoped tools).
 */
export interface SetupSessionInfo {
  ref: SessionRef;
  cwd: string;
  tools?: Tool[];
  pi?: Partial<PiOptions>;
  env?: Record<string, string>;
}

export interface SessionManagerOptions {
  /**
   * AgentPaths instance for all session/run path resolution.
   */
  paths: AgentPaths;
  runtime: Runtime;
  logger?: Logger;
  /**
   * Fallback env for bare-manager spawns whose setupSession supplies none. The agent host resolves
   * env in the runtime (ambient) and never sets this.
   */
  env?: Record<string, string>;
  /**
   * The tool bridge URL as the host reaches it, carried onto every SpawnRequest. The per-session
   * bearer token rides SpawnRequest.bridge.token (from setupSession). Absent → empty URL, no host
   * tools.
   */
  bridge?: { url: string };
  /**
   * Runs after the cwd exists, before setupSession and spawn — the agent host runs plugin
   * prepareSession hooks here (seeding the cwd, the session's $HOME). A rejection fails the spawn.
   */
  prepareSession?: (info: PrepareSessionInfo) => void | Promise<void>;
  /**
   * Runs after prepareSession, before spawn, to resolve the session's pi config + env (the agent
   * host runs the configureSession fold and mints the tool token here). Receives per-call overrides
   * only; the agent host merges them onto the base pi settings. A rejection fails the spawn.
   */
  setupSession?: (info: SetupSessionInfo) => Promise<SessionSetup | void> | SessionSetup | void;
  /**
   * Called when a session's process is torn down (reset, eviction, failure).
   */
  teardownSession?: (info: SessionRef) => void;
  /**
   * Revoke credentials immediately, independently of critical ownership release.
   */
  revokeSession?: (info: SessionRef) => void;
  /**
   * Evict a session after this long idle. A duration string (`"2h"`) or ms; `false` disables
   * eviction (the default). Checked on a fixed 60s sweep, so the granularity is ~60s.
   */
  idleTimeout?: string | number | false;
  /**
   * Max concurrent one-shot runs; excess queue FIFO. Default 10 — the cap stops a cron storm or a
   * hot ctx.run path from spawning unbounded processes.
   */
  maxRuns?: number;
  /**
   * Default per-turn timeout. Default: 15 minutes.
   */
  turnTimeoutMs?: number;
  /**
   * Override the per-request RPC timeout (tests).
   */
  requestTimeoutMs?: number;
  /**
   * Critical cleanup hooks, run serially and independently bounded before completion.
   */
  finalisers?: { name: string; run: (ctx: ExecutionFinalisation) => void | Promise<void> }[];
  /**
   * Maximum duration of each critical finaliser, default 30 seconds.
   */
  finalisationTimeoutMs?: number;
  /**
   * Settle admitted host operations; failure quarantines ownership and skips release hooks.
   */
  quiesceExecution?: (execution: ExecutionRef) => Promise<void>;
  /**
   * Override the post-spawn liveness delay (tests).
   */
  readyDelayMs?: number;
}

/**
 * The live process backing a slot: the running worker, its spawn cwd, and activity stats. Null when
 * the slot has no process — created at spawn, discarded at teardown, so a reset or eviction clears
 * it while the slot's queue and user pin survive.
 */
interface LiveSession {
  rpc: RpcSession;
  cwd: string;
  startedAt: Date;
  lastActiveAt: Date;
  turns: number;
}

/**
 * Per-key state. Outlives resets so the FIFO queue survives a respawn.
 */
interface Slot {
  ref: SessionRef;
  live: LiveSession | null;
  /**
   * Tail of the FIFO queue for this key.
   */
  queueTail: Promise<void>;
  /**
   * Queued + running work items — guards eviction.
   */
  pending: number;
  /**
   * Sticky current-user pin: the sender of the running (or most recent attributed) turn. Set when a
   * turn dequeues, before the session spawns, so even a session's first turn is attributed. Kept
   * after the turn ends (last-sender) and across resets; turns with no user leave it intact.
   */
  currentUser?: SessionIdentity;
  /**
   * Set by reset() (/new): the next spawn starts a fresh pi conversation (no --continue) instead of
   * resuming the prior transcript. One-shot — cleared once consumed. Involuntary respawns
   * (eviction, crash, restart) never set it, so they resume.
   */
  freshNextSpawn?: boolean;
  ephemeral?: boolean;
  reload?: ReloadOperation;
  reloadDone?: () => void;
  released?: boolean;
  closing?: boolean;
  quarantined?: boolean;
  generation?: number;
  acquisition?: Promise<void>;
  resetting?: Promise<void>;
  termination?: Promise<void>;
  active?: ManagedExecution;
}

/**
 * One queued or active execution and its cancellation boundary.
 */
interface ManagedExecution {
  ref: ExecutionRef;
  controller: TurnController;
  abort: AbortController;
  cancelled: Promise<never>;
  cancel(reason: string): void;
  phase: "queued" | "running" | "finalising";
}

/**
 * Owns every live session process: lazily-spawned pi workers with FIFO turn queueing per key,
 * concurrency across keys, idle eviction, and auto-reset on a failed turn. Plugins see
 * source-scoped `Sessions` namespaces; keys never collide across sources.
 */
export class SessionManager {
  private readonly opts: SessionManagerOptions;
  private readonly logger: Logger;
  private readonly slots = new Map<string, Slot>();
  private readonly idleTimeoutMs: number | false;
  private readonly maxRuns: number;
  private readonly turnTimeoutMs: number;
  private readonly readyDelayMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /**
   * One-shot run semaphore: live count + FIFO of waiting runs.
   */
  private activeRuns = 0;
  private readonly runQueue: (() => void)[] = [];
  private readonly pendingExecutions = new Set<ManagedExecution>();

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? silentLogger();
    const resolvedTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this.idleTimeoutMs = resolvedTimeout === false ? false : parseDuration(resolvedTimeout);
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.readyDelayMs = opts.readyDelayMs ?? READY_DELAY_MS;

    if (this.idleTimeoutMs !== false) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * The source-scoped Sessions facade handed to each plugin (and the host).
   */
  namespace(source: string): Sessions {
    return {
      run: (key, prompt, opts) => this.run(source, key, prompt, opts),
      open: (key, opts) => this.open(source, key, opts),
      get: (key) => {
        const slot = this.slots.get(fullKey(source, key));
        return slot?.live ? this.handle(slot) : undefined;
      },
      reset: (key) => this.reset(source, key),
      list: () => this.list(source),
    };
  }

  /**
   * Get-or-create the session and queue one turn on it (FIFO per key).
   */
  run(
    source: string,
    key: string,
    prompt: string,
    opts?: TurnOptions & { session?: SessionOptions },
  ): Turn {
    const slot = this.slot(source, key);
    const execution = this.createExecution(slot);
    const { controller } = execution;
    void this.enqueue(slot, async () => {
      if (opts?.user) slot.currentUser = opts.user;
      slot.ephemeral ??= opts?.session?.ephemeral ?? false;
      await this.execute(
        execution,
        slot,
        async () => {
          const live = await this.ensureLive(slot, opts?.session);
          live.lastActiveAt = new Date();
          const result = await this.driveTurn(controller, live.rpc, prompt, opts?.timeoutMs);
          live.turns++;
          live.lastActiveAt = new Date();
          return result;
        },
        Boolean(slot.ephemeral),
      );
    });

    return controller.turn;
  }

  /**
   * Get-or-create the session without prompting; returns its handle.
   */
  async open(source: string, key: string, opts?: SessionOptions): Promise<Session> {
    const slot = this.slot(source, key);
    await this.enqueue(slot, () => this.ensureLive(slot, opts));
    return this.handle(slot);
  }

  /**
   * Start a fresh conversation (a gateway's `/new`): kill the live process and flag the slot so the
   * next run begins a new pi session rather than resuming. Prior transcripts are kept on disk (for
   * a future `/resume`). Get-or-creates the slot so `/new` takes effect even after the session was
   * evicted (no live process).
   */
  async reset(source: string, key: string): Promise<void> {
    const slot = this.slot(source, key);
    if (slot.resetting) return slot.resetting;
    const active = slot.active;
    const reset = Promise.withResolvers<void>();
    slot.resetting = reset.promise;
    slot.freshNextSpawn = true;
    slot.generation = (slot.generation ?? 0) + 1;
    slot.closing = true;
    active?.cancel("session reset");
    try {
      await this.killLive(slot, !active);
      await active?.controller.turn.catch(() => {});
      this.logger.log("reset", { source, key });
    } catch (err) {
      slot.quarantined = true;
      throw err;
    } finally {
      slot.closing = false;
      slot.resetting = undefined;
      reset.resolve();
    }
  }

  /**
   * Sessions for one source (namespace view) or all (no source given).
   */
  list(source?: string): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.live) continue;
      if (source && slot.ref.source !== source) continue;
      infos.push({
        ref: slot.ref,
        startedAt: slot.live.startedAt,
        lastActiveAt: slot.live.lastActiveAt,
      });
    }
    return infos;
  }

  /**
   * The session's sticky current-user pin: whoever sent the running (or most recent attributed)
   * turn. Undefined until a turn carrying a user dequeues, and for keys that were never run.
   */
  currentUser(source: string, key: string): SessionIdentity | undefined {
    return this.slots.get(fullKey(source, key))?.currentUser;
  }

  /**
   * One-shot run: fresh session, one turn, tear down. Reuses the slot machinery on a transient slot
   * that never enters the registry (invisible to list(), no queue, no idle sweep). cwd defaults to
   * {dataDir}/{name}/sessions/host/{id}.
   */
  runOnce(source: string, prompt: string, opts: RunOptions = {}): Turn {
    const id = generateSessionId();
    const slot: Slot = {
      ref: { source, key: id },
      live: null,
      queueTail: Promise.resolve(),
      pending: 0,
    };
    slot.ephemeral = true;
    const execution = this.createExecution(slot);
    const { controller } = execution;
    void (async () => {
      try {
        await this.acquireRunSlot(execution.abort.signal);
      } catch (err) {
        await this.execute(
          execution,
          slot,
          async () => {
            throw err;
          },
          true,
        );
        return;
      }
      try {
        await this.execute(
          execution,
          slot,
          async () => {
            const live = await this.ensureLive(slot, {
              cwd: opts.cwd ?? this.opts.paths.runCwd(id),
              pi: opts.pi,
              env: opts.env,
              tools: opts.tools,
            });
            return this.driveTurn(controller, live.rpc, prompt, opts.timeoutMs);
          },
          true,
        );
      } finally {
        this.releaseRunSlot();
      }
    })();

    return controller.turn;
  }

  /**
   * Bounded one-shot concurrency: take a slot or wait FIFO for one.
   */
  private async acquireRunSlot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.activeRuns < this.maxRuns) {
      this.activeRuns++;
      return;
    }
    // The releasing run hands its slot over — no increment on wake.
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = this.runQueue.indexOf(admit);
        if (index >= 0) this.runQueue.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.runQueue.push(admit);
    });
  }

  private releaseRunSlot(): void {
    const next = this.runQueue.shift();
    if (next) {
      next(); // slot transferred to the next queued run; count unchanged
      return;
    }
    this.activeRuns--;
  }

  /**
   * Kill every live session process and stop background work (shutdown path).
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    for (const execution of this.pendingExecutions) execution.cancel("agent shutdown");
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Wake queued one-shots so they fail fast on the stopped check. This drains
    // the queue outside the acquire/release handoff, so activeRuns is left
    // inconsistent (goes negative) — deliberately unmaintained past stopAll, as
    // every later run rejects at ensureLive regardless of the count.
    while (this.runQueue.length) this.runQueue.shift()!();
    const kills = [...this.slots.values()].map((slot) => this.killLive(slot, !slot.active));
    await Promise.all(kills);
    await Promise.allSettled(
      [...this.pendingExecutions].map((execution) => execution.controller.turn),
    );
    this.slots.clear();
  }

  /**
   * Create a turn whose abort() follows the same path as a timeout: ask pi to stop and fail the
   * turn. Fire-and-forget callers (cron, tests) must not trip unhandled rejections — failures are
   * logged by the run paths.
   */
  private createExecution(slot: Slot): ManagedExecution {
    const abort = new AbortController();
    let cancel!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = reject;
    });
    cancelled.catch(() => {});
    const execution: ManagedExecution = {
      ref: { id: randomUUID(), session: slot.ref },
      abort,
      cancelled,
      phase: "queued",
      cancel(reason) {
        if (abort.signal.aborted) return;
        const error = new ExecutionError("cancelled", `Turn aborted: ${reason}`);
        abort.abort(error);
        if (slot.active === execution) slot.live?.rpc.abortTurn();
        cancel(error);
      },
      controller: createTurn({ onAbort: (reason) => execution.cancel(reason ?? "cancelled") }),
    };
    Object.defineProperty(execution.controller.turn, "execution", { value: execution.ref });
    execution.controller.turn.catch(() => {});
    this.pendingExecutions.add(execution);
    return execution;
  }

  /**
   * The bridge accepts tools only while an owning execution is running.
   */
  currentExecution(ref: SessionRef): { execution: ExecutionRef; signal: AbortSignal } | undefined {
    const active =
      this.slots.get(fullKey(ref.source, ref.key))?.active ??
      [...this.pendingExecutions].find(
        (item) =>
          item.ref.session.source === ref.source &&
          item.ref.session.key === ref.key &&
          item.phase !== "queued",
      );
    if (!active || active.phase !== "running" || active.abort.signal.aborted) return undefined;
    return { execution: active.ref, signal: active.abort.signal };
  }

  /**
   * Run work and every finaliser before exposing one terminal outcome.
   */
  private async execute(
    execution: ManagedExecution,
    slot: Slot,
    operation: () => Promise<TurnResult>,
    close = false,
  ): Promise<void> {
    const executionStartedAt = Date.now();
    slot.active = execution;
    execution.phase = "running";
    this.logger.log("execution started", { ...slot.ref, executionId: execution.ref.id });
    let result: TurnResult | undefined;
    let primary: Error | undefined;
    const errors: Error[] = [];
    try {
      await this.performReload(slot);
      if (execution.abort.signal.aborted) throw execution.abort.signal.reason;
      result = await Promise.race([operation(), execution.cancelled]);
    } catch (err) {
      primary = err instanceof Error ? err : new Error(String(err));
      execution.abort.abort(primary);
      try {
        await this.killLive(slot, false);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    execution.phase = "finalising";
    const outcome: ExecutionOutcome = {
      status:
        primary instanceof ExecutionError &&
        (primary.code === "cancelled" || primary.code === "timeout")
          ? primary.code
          : primary
            ? "error"
            : "success",
      error: primary,
    };
    execution.abort.abort(new Error("Execution is finalising"));
    let quarantined = Boolean(slot.quarantined);
    try {
      await finaliseWithin(async () => {
        await slot.acquisition;
        await this.opts.quiesceExecution?.(execution.ref);
      }, this.opts.finalisationTimeoutMs ?? 30_000);
    } catch (err) {
      errors.push(
        new Error("Host tools did not settle; execution ownership is quarantined", { cause: err }),
      );
      quarantined = true;
      slot.quarantined = true;
    }
    for (const finaliser of quarantined ? [] : (this.opts.finalisers ?? [])) {
      try {
        await finaliseWithin(
          (signal) => finaliser.run({ execution: execution.ref, outcome, signal }),
          this.opts.finalisationTimeoutMs ?? 30_000,
        );
      } catch (err) {
        errors.push(new Error(`Finaliser ${finaliser.name} failed`, { cause: err }));
        slot.quarantined = true;
        quarantined = true;
      }
    }
    if (!close && !primary && !errors.length) await this.performReload(slot);
    if (close || primary || errors.length || slot.closing || this.stopped) {
      try {
        await this.killLive(slot, !quarantined);
        this.opts.revokeSession?.(slot.ref);
        if (!quarantined && !slot.released) {
          this.opts.teardownSession?.(slot.ref);
          slot.released = true;
        }
      } catch (error) {
        slot.quarantined = true;
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    slot.active = undefined;
    this.pendingExecutions.delete(execution);
    execution.controller.emit({ type: "turn_end" });
    if (primary || errors.length) {
      this.logger.error("execution failed", {
        ...slot.ref,
        executionId: execution.ref.id,
        error: primary?.message,
        finalisationErrors: errors.length,
      });
      execution.controller.reject(
        errors.length ? new ExecutionFailure(execution.ref, primary, errors) : primary!,
      );
    } else {
      this.logger.log("execution completed", { ...slot.ref, executionId: execution.ref.id });
      execution.controller.resolve({
        ...result!,
        executionId: execution.ref.id,
        durationMs: Date.now() - executionStartedAt,
      });
    }
  }

  /**
   * Request a serialised resource reload without starting a model turn.
   */
  requestReload(ref: SessionRef): ReloadOperation {
    const slot = this.slots.get(fullKey(ref.source, ref.key));
    if (slot?.reload?.status === "scheduled") return slot.reload;
    const operation: ReloadOperation = {
      id: randomUUID(),
      status: !slot?.live || slot.ephemeral ? "not-needed" : "scheduled",
      completed: Promise.resolve(),
    };
    if (!slot) return operation;
    slot.reload = operation;
    if (operation.status === "not-needed") return operation;
    operation.completed = new Promise<void>((resolve) => {
      slot.reloadDone = resolve;
    });
    void this.enqueue(slot, () => this.performReload(slot));
    return operation;
  }

  /**
   * Consume a pending reload before any later queued prompt.
   */
  private async performReload(slot: Slot): Promise<void> {
    const operation = slot.reload;
    if (!operation || operation.status !== "scheduled") return;
    const complete = slot.reloadDone;
    try {
      if (!slot.live || this.stopped) operation.status = "interrupted";
      else {
        await slot.live.rpc.reload();
        if (operation.status === "scheduled") operation.status = "completed";
      }
    } catch (err) {
      if (operation.status !== "scheduled") return;
      operation.status = "failed";
      operation.error = "Resource reload failed; inspect session diagnostics.";
      this.logger.error("resource reload failed", {
        ...slot.ref,
        reloadId: operation.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.killLive(slot);
    } finally {
      complete?.();
      if (slot.reload === operation) slot.reloadDone = undefined;
    }
  }

  /**
   * Get-or-create the per-key slot (queue + live state).
   */
  private slot(source: string, key: string): Slot {
    const slotKey = fullKey(source, key);
    let slot = this.slots.get(slotKey);
    if (!slot) {
      slot = { ref: { source, key }, live: null, queueTail: Promise.resolve(), pending: 0 };
      this.slots.set(slotKey, slot);
    }
    return slot;
  }

  /**
   * Append work to a slot's FIFO queue. `pending` covers queued + running items so the idle sweep
   * never evicts a session with work in flight.
   */
  private enqueue<T>(slot: Slot, task: () => Promise<T>): Promise<T> {
    slot.pending++;
    const settle = () => {
      slot.pending--;
      return undefined;
    };
    const result = slot.queueTail.then(async () => {
      while (slot.resetting) await slot.resetting;
      return task();
    });
    slot.queueTail = result.then(settle, settle);
    return result;
  }

  /**
   * Run one prompt through an RPC session, bracketing it with turn events. Returns the result; the
   * caller settles the controller (sessions settle after bookkeeping, one-shots after teardown).
   */
  private async driveTurn(
    controller: TurnController,
    rpc: RpcSession,
    prompt: string,
    timeoutMs?: number,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    controller.emit({ type: "turn_start" });
    const text = await rpc.prompt(prompt, {
      timeoutMs: timeoutMs ?? this.turnTimeoutMs,
      onEvent: (event) => controller.emit(event),
    });
    return { text, durationMs: Date.now() - startedAt };
  }

  /**
   * The public Session facade over a slot.
   */
  private handle(slot: Slot): Session {
    return {
      reload: () => this.requestReload(slot.ref),
      reloadStatus: () => slot.reload,
      key: slot.ref.key,
      cwd: slot.live?.cwd ?? this.defaultCwd(slot.ref),
      run: (prompt, opts) => this.run(slot.ref.source, slot.ref.key, prompt, opts),
      stats: async (): Promise<SessionStats> => {
        const live = slot.live;
        if (!live) throw new Error(`Session ${slot.ref.key} is not live`);
        return {
          tokens: await live.rpc.stats(),
          turns: live.turns,
          startedAt: live.startedAt,
          lastActiveAt: live.lastActiveAt,
        };
      },
      reset: () => this.reset(slot.ref.source, slot.ref.key),
    };
  }

  private defaultCwd(ref: SessionRef): string {
    return this.opts.paths.sessionCwd(ref);
  }

  /**
   * Get-or-create the live session process for a slot. Runs inside the FIFO queue (one-shot runs
   * call it directly on their transient slot).
   */
  private async ensureLive(slot: Slot, opts?: SessionOptions): Promise<LiveSession> {
    slot.ephemeral ??= opts?.ephemeral ?? false;
    if (slot.termination) await slot.termination;
    if (this.stopped) throw new Error("Session manager is stopped");
    if (slot.quarantined)
      throw new Error(
        "Session ownership is quarantined; reconcile interrupted work before restarting",
      );
    if (slot.acquisition) throw new Error("Previous session preparation is still pending");
    if (slot.live && !slot.live.rpc.isAlive()) {
      this.logger.error("session process died, respawning", slot.ref);
      slot.live = null;
    }
    if (slot.live) return slot.live;
    const signal = slot.active?.abort.signal;
    const generation = slot.generation;
    const check = () => {
      signal?.throwIfAborted();
      if (this.stopped || slot.generation !== generation)
        throw new ExecutionError("cancelled", "Session preparation was cancelled");
    };
    check();
    const prepared = Promise.withResolvers<void>();
    slot.acquisition = prepared.promise;
    const cwd = opts?.cwd ?? this.defaultCwd(slot.ref);
    const resume = !slot.freshNextSpawn;
    slot.freshNextSpawn = false;
    slot.released = false;
    let rpc: RpcSession | undefined;
    try {
      rpc = await this.spawn({
        ref: slot.ref,
        cwd,
        pi: opts?.pi,
        env: opts?.env,
        tools: opts?.tools,
        resume,
        check,
      });
      check();
      slot.live = { rpc, cwd, startedAt: new Date(), lastActiveAt: new Date(), turns: 0 };
      return slot.live;
    } catch (err) {
      this.opts.revokeSession?.(slot.ref);
      await rpc?.kill();
      throw err;
    } finally {
      slot.acquisition = undefined;
      prepared.resolve();
    }
  }

  /**
   * Resolve the session's pi config (via setupSession), build the SpawnRequest, spawn through the
   * runtime, and verify the worker survived the ready delay.
   */
  private async spawn(info: {
    ref: SessionRef;
    cwd: string;
    pi?: Partial<PiOptions>;
    env?: Record<string, string>;
    tools?: Tool[];
    resume?: boolean;
    check: () => void;
  }): Promise<RpcSession> {
    await mkdir(info.cwd, { recursive: true });
    info.check();
    const { ref } = info;
    await this.opts.prepareSession?.({ ref, cwd: info.cwd });
    info.check();

    // setupSession resolves the pi config, tool manifest, per-session env, and bridge token. It
    // receives only per-call values; the agent host merges the pi overrides onto the base pi
    // settings it owns.
    const setup = await this.opts.setupSession?.({
      ref,
      cwd: info.cwd,
      tools: info.tools,
      pi: info.pi,
      env: info.env,
    });

    info.check();
    this.logger.log("spawning", { ...ref, cwd: info.cwd });
    const spec: SpawnRequest = {
      ref,
      cwd: info.cwd,
      // A setup-provided env is the complete host-contributed child env (the fold's output, e.g. a
      // gateway's per-session token); the base + per-session merge is the bare-manager fallback.
      // Ambient host env is layered on by the runtime; the bridge token rides `bridge.token`.
      env: setup?.env ?? { ...this.opts.env, ...info.env },
      pi: setup?.pi ?? {},
      tools: setup?.tools,
      resume: info.resume,
      bridge: { url: this.opts.bridge?.url ?? "", token: setup?.bridgeToken },
    };
    const proc = await this.opts.runtime.spawn(spec);
    try {
      info.check();
    } catch (err) {
      await proc.kill();
      throw err;
    }
    const rpc = new RpcSession(fullKey(ref.source, ref.key), proc, {
      logger: this.logger,
      requestTimeoutMs: this.opts.requestTimeoutMs,
    });

    // No ready message from RPC mode — wait briefly, then check it's alive.
    if (this.readyDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.readyDelayMs));
    try {
      info.check();
    } catch (err) {
      await rpc.kill();
      throw err;
    }
    if (!rpc.isAlive()) {
      const stderr = rpc.stderrTail();
      const hint = /execvp/.test(stderr)
        ? " (command not found inside the session environment)"
        : /Cannot find module|ERR_MODULE_NOT_FOUND/.test(stderr)
          ? " (an extension's dependency is not visible inside the session — bundle the" +
            " extension so its deps are inlined, or mount its node_modules tree(s) via" +
            " bwrap({ mounts }))"
          : "";
      throw new Error(`session worker exited prematurely${stderr ? `: ${stderr}` : ""}${hint}`);
    }
    return rpc;
  }

  /**
   * Tear down a slot's live process (if any); the slot and its queue survive.
   */
  private async killLive(slot: Slot, release = true): Promise<void> {
    if (slot.termination) return slot.termination;
    this.opts.revokeSession?.(slot.ref);
    if (slot.reload?.status === "scheduled") {
      slot.reload.status = "interrupted";
      slot.reloadDone?.();
      slot.reloadDone = undefined;
    }
    const live = slot.live;
    if (!live) return;
    slot.live = null;
    const termination = Promise.resolve().then(async () => {
      try {
        if (release && !slot.released) {
          this.opts.teardownSession?.(slot.ref);
          slot.released = true;
        }
      } finally {
        await live.rpc.kill();
      }
    });
    slot.termination = termination;
    try {
      await termination;
    } catch (err) {
      slot.quarantined = true;
      throw err;
    } finally {
      slot.termination = undefined;
    }
  }

  /**
   * Evict sessions idle past the timeout (skips any with work in flight).
   */
  private sweepIdle(): void {
    if (this.idleTimeoutMs === false) return;
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [slotKey, slot] of this.slots) {
      if (!slot.live || slot.pending > 0) continue;
      if (slot.live.lastActiveAt.getTime() > cutoff) continue;
      this.logger.log("evicting idle session", { ...slot.ref });
      void this.killLive(slot);
      this.slots.delete(slotKey);
    }
  }
}

/**
 * Namespaced slot key — keys never collide across sources.
 */
function fullKey(source: string, key: string): string {
  return `${source}/${key}`;
}

/**
 * Parse a duration: "1d" / "2h" / "30m" / "45s" / "1500ms" (also plain numbers, treated as ms).
 */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${JSON.stringify(value)}`);
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n * factor;
}
