import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { classifyFailure, type Failure } from "./failure.js";
import { RpcSession, RpcOperationError, type StopReason } from "./rpc.js";
import { scopeLogger, silentLogger } from "../utils/logger.js";
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
  logger: Logger;
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

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    this.logger = scopeLogger(opts.logger ?? silentLogger(), {});
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
    const requestId = opts?.requestId ?? randomUUID();
    slot.logger.log("request.accepted", { requestId });
    const acceptedAt = Date.now();
    const controller = this.createTurnController(slot, requestId);

    void this.enqueue(
      slot,
      async () => {
        // Pin the sender at dequeue, before ensureLive: FIFO guarantees at most
        // one running turn per key, so the pin is unambiguous for the whole
        // turn — including a first turn's spawn (when MCP clients initialize).
        if (opts?.user) slot.currentUser = opts.user;
        let promptStarted = false;
        try {
          const live = await this.ensureLive(slot, opts?.session, requestId);
          live.lastActiveAt = new Date();
          promptStarted = true;
          const result = await this.driveTurn(
            controller,
            live.rpc,
            prompt,
            requestId,
            opts?.timeoutMs,
          );
          live.turns++;
          live.lastActiveAt = new Date();
          controller.resolve(result);
        } catch (err) {
          // A failed turn (timeout, crash, dead process) can leave the pi
          // process wedged, poisoning every later turn — kill the session
          // process so the next run starts fresh.
          if (!promptStarted)
            slot.logger.error("request.finished", {
              requestId,
              outcome: "failed",
              durationMs: Date.now() - acceptedAt,
              ...(err instanceof RpcOperationError ? err.failure : classifyFailure(err, "startup")),
            });
          slot.logger.error("request.recovery_started", {
            requestId,
            ...(err instanceof RpcOperationError ? err.failure : classifyFailure(err, "model")),
            ...(err instanceof RpcOperationError && err.rpcCommand
              ? { rpcCommand: err.rpcCommand }
              : {}),
          });
          await this.killLive(slot, recoveryReason(err));
          controller.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      requestId,
    );

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
    slot.freshNextSpawn = true;
    await this.killLive(slot, "reset");
    slot.logger.log("session.reset");
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
    const slot = this.createSlot({ source, key: id });
    const requestId = opts.requestId ?? randomUUID();
    slot.logger.log("request.accepted", { requestId });
    const acceptedAt = Date.now();
    const controller = this.createTurnController(slot, requestId);

    void (async () => {
      await this.acquireRunSlot(slot, requestId);
      let result: TurnResult | null = null;
      let failure: Error | null = null;
      let promptStarted = false;
      try {
        const live = await this.ensureLive(
          slot,
          {
            cwd: opts.cwd ?? this.opts.paths.runCwd(id),
            pi: opts.pi,
            env: opts.env,
            tools: opts.tools,
          },
          requestId,
        );
        promptStarted = true;
        result = await this.driveTurn(controller, live.rpc, prompt, requestId, opts.timeoutMs);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        // Settle only after teardown — a resolved one-shot has no live
        // process. A failed spawn leaves no live state but may have minted
        // a token.
        if (slot.live)
          await this.killLive(slot, failure ? recoveryReason(failure) : "one_shot_completed");
        else this.opts.teardownSession?.(slot.ref);
        this.releaseRunSlot();
        if (!promptStarted && failure)
          slot.logger.error("request.finished", {
            requestId,
            outcome: "failed",
            durationMs: Date.now() - acceptedAt,
            ...(failure instanceof RpcOperationError
              ? failure.failure
              : classifyFailure(failure, "startup")),
          });
        if (failure) controller.reject(failure);
        else controller.resolve(result!);
      }
    })();

    return controller.turn;
  }

  /**
   * Bounded one-shot concurrency: take a slot or wait FIFO for one.
   */
  private async acquireRunSlot(slot: Slot, requestId: string): Promise<void> {
    if (this.activeRuns < this.maxRuns) {
      this.activeRuns++;
      return;
    }
    const queuedAt = Date.now();
    slot.logger.log("request.queued", {
      requestId,
      activeRuns: this.activeRuns,
      queuedRuns: this.runQueue.length + 1,
    });
    // The releasing run hands its slot over — no increment on wake.
    await new Promise<void>((resolve) => this.runQueue.push(resolve));
    slot.logger.log("request.admitted", { requestId, queueWaitMs: Date.now() - queuedAt });
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
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Wake queued one-shots so they fail fast on the stopped check. This drains
    // the queue outside the acquire/release handoff, so activeRuns is left
    // inconsistent (goes negative) — deliberately unmaintained past stopAll, as
    // every later run rejects at ensureLive regardless of the count.
    while (this.runQueue.length) this.runQueue.shift()!();
    const kills = [...this.slots.values()].map((slot) => this.killLive(slot, "host_shutdown"));
    await Promise.all(kills);
    this.slots.clear();
  }

  /**
   * Create a turn whose abort() follows the same path as a timeout: ask pi to stop and fail the
   * turn. Fire-and-forget callers (cron, tests) must not trip unhandled rejections — failures are
   * logged by the run paths.
   */
  private createTurnController(slot: Slot, requestId: string): TurnController {
    const controller = createTurn({
      onAbort: (reason) => {
        slot.logger.log("request.cancel_requested", { requestId });
        slot.live?.rpc.abortTurn(requestId);
        controller.reject(new Error(`Turn aborted${reason ? `: ${reason}` : ""}`));
      },
    });
    controller.turn.catch(() => {});
    return controller;
  }

  /**
   * Get-or-create the per-key slot (queue + live state).
   */
  private slot(source: string, key: string): Slot {
    const slotKey = fullKey(source, key);
    let slot = this.slots.get(slotKey);
    if (!slot) {
      slot = this.createSlot({ source, key });
      this.slots.set(slotKey, slot);
    }
    return slot;
  }

  /**
   * Bind the logical session identity without owning a logging destination.
   */
  private createSlot(ref: SessionRef): Slot {
    return {
      ref,
      logger: scopeLogger(this.logger, { ...ref }),
      live: null,
      queueTail: Promise.resolve(),
      pending: 0,
    };
  }

  /**
   * Append work to a slot's FIFO queue. `pending` covers queued + running items so the idle sweep
   * never evicts a session with work in flight.
   */
  private enqueue<T>(slot: Slot, task: () => Promise<T>, requestId?: string): Promise<T> {
    const queuedAt = slot.pending > 0 ? Date.now() : null;
    if (queuedAt !== null) {
      slot.logger.log("request.queued", { requestId, ahead: slot.pending });
    }
    slot.pending++;
    const settle = () => {
      slot.pending--;
      return undefined;
    };
    const result = slot.queueTail.then(() => {
      if (queuedAt !== null) {
        slot.logger.log("request.admitted", {
          requestId,
          queueWaitMs: Date.now() - queuedAt,
        });
      }
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
    requestId: string,
    timeoutMs?: number,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    controller.emit({ type: "turn_start" });
    const text = await rpc.prompt(prompt, {
      requestId,
      timeoutMs: timeoutMs ?? this.turnTimeoutMs,
      onEvent: (event) => controller.emit(event),
    });
    controller.emit({ type: "turn_end" });
    return { text, durationMs: Date.now() - startedAt };
  }

  /**
   * The public Session facade over a slot.
   */
  private handle(slot: Slot): Session {
    return {
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
  private async ensureLive(
    slot: Slot,
    opts?: SessionOptions,
    requestId?: string,
  ): Promise<LiveSession> {
    if (this.stopped) throw new Error("Session manager is stopped");

    if (slot.live && !slot.live.rpc.isAlive()) {
      slot.logger.log("worker.respawn_requested");
      slot.live = null;
    }

    if (slot.live) return slot.live;

    const cwd = opts?.cwd ?? this.defaultCwd(slot.ref);
    // Resume the prior transcript unless reset() flagged a fresh start (/new). One-shot flag.
    const resume = !slot.freshNextSpawn;
    slot.freshNextSpawn = false;
    const rpc = await this.spawn({
      ref: slot.ref,
      requestId,
      logger: slot.logger,
      cwd,
      pi: opts?.pi,
      env: opts?.env,
      tools: opts?.tools,
      resume,
    });
    slot.live = {
      rpc,
      cwd,
      startedAt: new Date(),
      lastActiveAt: new Date(),
      turns: 0,
    };
    return slot.live;
  }

  /**
   * Resolve the session's pi config (via setupSession), build the SpawnRequest, spawn through the
   * runtime, and verify the worker survived the ready delay.
   */
  private async spawn(info: {
    ref: SessionRef;
    requestId?: string;
    logger: Logger;
    cwd: string;
    pi?: Partial<PiOptions>;
    env?: Record<string, string>;
    tools?: Tool[];
    resume?: boolean;
  }): Promise<RpcSession> {
    const startedAt = Date.now();
    const workerId = randomUUID();
    const workerLogger = scopeLogger(info.logger, { workerId });
    workerLogger.log("worker.starting", {
      requestId: info.requestId,
      cwd: info.cwd,
      runtime: this.opts.runtime.name,
    });
    try {
      await mkdir(info.cwd, { recursive: true });
      const { ref } = info;
      await this.opts.prepareSession?.({ ref, cwd: info.cwd });

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
      const rpc = new RpcSession(ref.key, proc, {
        logger: workerLogger,
        workerId,
        requestTimeoutMs: this.opts.requestTimeoutMs,
      });

      // No ready message from RPC mode — wait briefly, then check it's alive.
      if (this.readyDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.readyDelayMs));
      if (!rpc.isAlive()) throw startupError(rpc);
      await rpc.refreshState();
      if (!rpc.isAlive()) throw startupError(rpc);
      workerLogger.log("worker.started", {
        requestId: info.requestId,
        startupMs: Date.now() - startedAt,
        resume: info.resume ?? false,
      });
      return rpc;
    } catch (err) {
      workerLogger.error("worker.start_failed", {
        requestId: info.requestId,
        ...(err instanceof RpcOperationError ? err.failure : classifyFailure(err, "startup")),
      });
      throw err;
    }
  }

  /**
   * Tear down a slot's live process (if any); the slot and its queue survive.
   */
  private async killLive(slot: Slot, reason: StopReason): Promise<void> {
    const live = slot.live;
    if (!live) return;
    slot.live = null;
    this.opts.teardownSession?.(slot.ref);
    await live.rpc
      .kill(reason)
      .catch((err) =>
        slot.logger.error("worker.stop_failed", { reason, ...classifyFailure(err, "cleanup") }),
      );
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
      slot.logger.log("session.idle_expired", {
        idleMs: Date.now() - slot.live.lastActiveAt.getTime(),
        inFlight: false,
      });
      void this.killLive(slot, "idle_eviction");
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

/**
 * Preserve timeout/cancellation causes from Picco-owned operation failures.
 */
function recoveryReason(error: unknown): StopReason {
  if (error instanceof RpcOperationError) {
    if (error.failure.category === "timeout") return "timeout";
    if (error.failure.category === "cancelled") return "cancelled";
  }
  return "turn_failed";
}

/**
 * Preserve private startup detail for callers and select only known operational causes.
 */
function startupError(rpc: RpcSession): RpcOperationError {
  const stderr = rpc.stderrTail();
  let failure: Failure = classifyFailure(stderr.replace(/^Error: /, ""), "startup");
  let hint = "";
  if (/execvp/.test(stderr)) {
    failure = { category: "runtime", phase: "startup", reason: "command_not_found" };
    hint = " (command not found inside the session environment)";
  } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(stderr)) {
    failure = { category: "runtime", phase: "startup", reason: "dependency_unavailable" };
    hint =
      " (an extension's dependency is not visible inside the session — bundle the extension so its deps are inlined, or mount its node_modules tree(s) via bwrap({ mounts }))";
  } else if (failure.category === "unknown")
    failure = { category: "runtime", phase: "startup", reason: "worker_exited" };
  return new RpcOperationError(
    `session worker exited prematurely${stderr ? `: ${stderr}` : ""}${hint}`,
    failure,
  );
}
