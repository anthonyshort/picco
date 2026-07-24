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
    const controller = this.createTurnController(() => slot.live?.rpc);

    void this.enqueue(slot, async () => {
      // Pin the sender at dequeue, before ensureLive: FIFO guarantees at most
      // one running turn per key, so the pin is unambiguous for the whole
      // turn — including a first turn's spawn (when MCP clients initialize).
      if (opts?.user) slot.currentUser = opts.user;
      try {
        const live = await this.ensureLive(slot, opts?.session);
        live.lastActiveAt = new Date();
        const result = await this.driveTurn(controller, live.rpc, prompt, opts?.timeoutMs);
        live.turns++;
        live.lastActiveAt = new Date();
        controller.resolve(result);
      } catch (err) {
        // A failed turn (timeout, crash, dead process) can leave the pi
        // process wedged, poisoning every later turn — kill the session
        // process so the next run starts fresh.
        this.logger.error("turn failed, resetting session", {
          ...slot.ref,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.killLive(slot);
        controller.reject(err instanceof Error ? err : new Error(String(err)));
      }
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
    slot.freshNextSpawn = true;
    await this.killLive(slot);
    this.logger.log("reset", { source, key });
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
    const controller = this.createTurnController(() => slot.live?.rpc);

    void (async () => {
      await this.acquireRunSlot();
      let result: TurnResult | null = null;
      let failure: Error | null = null;
      try {
        const live = await this.ensureLive(slot, {
          cwd: opts.cwd ?? this.opts.paths.runCwd(id),
          pi: opts.pi,
          env: opts.env,
          tools: opts.tools,
        });
        result = await this.driveTurn(controller, live.rpc, prompt, opts.timeoutMs);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        // Settle only after teardown — a resolved one-shot has no live
        // process. A failed spawn leaves no live state but may have minted
        // a token.
        if (slot.live) await this.killLive(slot);
        else this.opts.teardownSession?.(slot.ref);
        this.releaseRunSlot();
        if (failure) controller.reject(failure);
        else controller.resolve(result!);
      }
    })();

    return controller.turn;
  }

  /**
   * Bounded one-shot concurrency: take a slot or wait FIFO for one.
   */
  private async acquireRunSlot(): Promise<void> {
    if (this.activeRuns < this.maxRuns) {
      this.activeRuns++;
      return;
    }
    // The releasing run hands its slot over — no increment on wake.
    await new Promise<void>((resolve) => this.runQueue.push(resolve));
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
    const kills = [...this.slots.values()].map((slot) => this.killLive(slot));
    await Promise.all(kills);
    this.slots.clear();
  }

  /**
   * Create a turn whose abort() follows the same path as a timeout: ask pi to stop and fail the
   * turn. Fire-and-forget callers (cron, tests) must not trip unhandled rejections — failures are
   * logged by the run paths.
   */
  private createTurnController(getRpc: () => RpcSession | null | undefined): TurnController {
    const controller = createTurn({
      onAbort: (reason) => {
        getRpc()?.abortTurn();
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
    const result = slot.queueTail.then(task);
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
  private async ensureLive(slot: Slot, opts?: SessionOptions): Promise<LiveSession> {
    if (this.stopped) throw new Error("Session manager is stopped");

    if (slot.live && !slot.live.rpc.isAlive()) {
      this.logger.error("session process died, respawning", slot.ref);
      slot.live = null;
    }

    if (slot.live) return slot.live;

    const cwd = opts?.cwd ?? this.defaultCwd(slot.ref);
    // Resume the prior transcript unless reset() flagged a fresh start (/new). One-shot flag.
    const resume = !slot.freshNextSpawn;
    slot.freshNextSpawn = false;
    const rpc = await this.spawn({
      ref: slot.ref,
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
    cwd: string;
    pi?: Partial<PiOptions>;
    env?: Record<string, string>;
    tools?: Tool[];
    resume?: boolean;
  }): Promise<RpcSession> {
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
    const rpc = new RpcSession(fullKey(ref.source, ref.key), proc, {
      logger: this.logger,
      requestTimeoutMs: this.opts.requestTimeoutMs,
    });

    // No ready message from RPC mode — wait briefly, then check it's alive.
    if (this.readyDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.readyDelayMs));
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
  private async killLive(slot: Slot): Promise<void> {
    const live = slot.live;
    if (!live) return;
    slot.live = null;
    this.opts.teardownSession?.(slot.ref);
    await live.rpc.kill().catch((err) =>
      this.logger.error("session kill failed", {
        ...slot.ref,
        error: err instanceof Error ? err.message : String(err),
      }),
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
