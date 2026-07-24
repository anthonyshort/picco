import { Cron as Croner } from "croner";
import type { Cron } from "croner";
import isEqual from "fast-deep-equal";
import { createLogger, errorMessage, type ThinkingLevel } from "@picco-agent/core";
import type { JobConfig, JobConfigUpdate, JobLoader } from "./loader.js";

const logger = createLogger("job-scheduler");

const DEFAULT_SCRIPT_TIMEOUT = 300; // seconds

/**
 * In-memory state for a loaded job, including its armed timer and run counters.
 */
interface ScheduledJob {
  id: string;
  config: JobConfig;
  cron: Cron | null;
  running: boolean;
  /**
   * ISO timestamp of the last completed run (since process start).
   */
  lastRun: string | null;
  /**
   * Completed runs since the process started.
   */
  fireCount: number;
}

/**
 * Lightweight job snapshot for listing, without internal timer references.
 */
export interface JobState {
  id: string;
  type: JobConfig["type"];
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  fireCount: number;
}

/**
 * One completed run's outcome — handed to CronOptions.onRunComplete.
 */
export interface JobRun {
  jobId: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "error";
  /**
   * The agent's final text, or the script's combined output.
   */
  output?: string;
  error?: string;
}

/**
 * Runs an agent job and returns its final text output. Injected so the scheduler stays decoupled
 * from the agent runtime (see index.ts).
 */
export type RunAgent = (opts: {
  jobId: string;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
}) => Promise<string>;

/**
 * Runs a script job's command and returns its output (throws on failure). Injected so the scheduler
 * stays decoupled from how scripts execute (see index.ts).
 */
export type RunScript = (opts: {
  jobId: string;
  command: string;
  timeoutMs: number;
}) => Promise<string>;

/**
 * Receives every completed run's outcome. May be async (e.g. writing run history to a file or
 * database) — a rejection is logged, never thrown into the run loop.
 */
export type OnRunComplete = (run: JobRun) => void | Promise<void>;

export interface JobSchedulerOptions {
  loader: JobLoader;
  runAgent: RunAgent;
  runScript: RunScript;
  onRunComplete: OnRunComplete;
}

/**
 * Arms croner timers for loaded jobs, fires them with overlap-skip, and reports every completed run
 * to the injected onRunComplete hook. Keeps no state on disk; job execution is injected
 * (runAgent/runScript) so the scheduler stays decoupled from the agent runtime.
 */
export class JobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private readonly loader: JobLoader;
  private readonly runAgent: RunAgent;
  private readonly runScript: RunScript;
  private readonly onRunComplete: OnRunComplete;

  constructor(options: JobSchedulerOptions) {
    this.loader = options.loader;
    this.runAgent = options.runAgent;
    this.runScript = options.runScript;
    this.onRunComplete = options.onRunComplete;
  }

  /**
   * List all loaded jobs as structured data (run stats are in-memory, counted since the process
   * started).
   */
  listJobs(): JobState[] {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      type: job.config.type,
      schedule: job.config.schedule,
      enabled: job.config.enabled,
      lastRun: job.lastRun,
      fireCount: job.fireCount,
    }));
  }

  /**
   * Add a job by writing its YAML file, then reload to arm it. Throws if the id is already loaded —
   * silently overwriting would leave the old timer armed with the old config.
   */
  async addJob(config: JobConfig): Promise<void> {
    if (this.jobs.has(config.id)) {
      throw new Error(`Job "${config.id}" already exists — use cron_update to change it.`);
    }

    // Write YAML file — if this fails, nothing is added in memory.
    await this.loader.save(config);
    await this.reload();
  }

  /**
   * Remove a job: disarm it, drop it from memory, delete its file.
   */
  async removeJob(id: string): Promise<string> {
    this.stopJobTimer(id);
    this.jobs.delete(id);
    await this.loader.remove(id);
    return `Job "${id}" removed.`;
  }

  /**
   * Update selected fields on an existing job (including `enabled`). Persists to disk, rebuilds the
   * in-memory job and restarts its timer.
   */
  async updateJob(id: string, partial: JobConfigUpdate): Promise<string> {
    const updated = await this.loader.update(id, partial);

    // Rebuild the job in-memory so timers pick up the new config.
    // (reload() won't detect the change because the cached config object
    // is the same reference — isEqual returns true.)
    this.stopJobTimer(id);
    this.jobs.set(id, this.buildLoadedJob(updated));
    if (updated.enabled) this.startJobTimer(id);

    return `Job "${updated.id}" updated.`;
  }

  /**
   * Fire a job in the background; reports trigger status immediately. Used by cron_run — agent jobs
   * can take minutes, and the tool call must not block the model that long.
   */
  triggerJob(id: string): string {
    const job = this.jobs.get(id);
    if (!job) return `Job "${id}" not found.`;
    if (!job.config.enabled) return `Job "${id}" is disabled.`;
    this.fireJob(id).catch((err) => {
      logger.error(`triggered run failed for ${id}`, err);
    });
    return `Job "${id}" triggered — running in the background.`;
  }

  /**
   * Stop all job timers. Called during shutdown.
   */
  stopAllTimers(): void {
    for (const id of this.jobs.keys()) {
      this.stopJobTimer(id);
    }
  }

  /**
   * Reconcile this.jobs with the current configs from the loader. Stops removed jobs, restarts
   * changed jobs, starts new jobs.
   */
  async reload(): Promise<void> {
    const prevConfigs = this.loader.getAll();
    const newConfigs = await this.loader.refresh();

    // Jobs on disk
    for (const [id, config] of newConfigs) {
      const prev = this.jobs.get(id);
      const prevConfig = prevConfigs.get(id);

      if (!prev || !prevConfig) {
        // New job — build and arm if enabled
        this.jobs.set(id, this.buildLoadedJob(config));
        if (config.enabled) this.startJobTimer(id);
        logger.log(`loaded ${id}`);
      } else if (!isEqual(prevConfig, config)) {
        // Changed — disarm old, build new, arm if enabled
        this.stopJobTimer(id);
        this.jobs.set(id, this.buildLoadedJob(config));
        if (config.enabled) this.startJobTimer(id);
        logger.log(`reloaded ${id}`);
      }
    }

    // Jobs in memory but gone from disk — stop and remove
    for (const id of [...this.jobs.keys()]) {
      if (!newConfigs.has(id)) {
        this.stopJobTimer(id);
        this.jobs.delete(id);
        logger.log(`removed job ${id}`);
      }
    }
  }

  /**
   * Run one job to completion, with overlap-skip; the outcome goes to onRunComplete. A no-op for an
   * id that is no longer loaded (a timer can fire in the same tick its job is removed).
   */
  async fireJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    if (job.running) {
      logger.log(`${job.id} skipped (already running)`);
      return;
    }

    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    job.running = true;

    logger.log(`Starting ${job.id} (${job.config.type})`);

    const run: JobRun = { jobId: job.id, startedAt, durationMs: 0, status: "success" };

    try {
      run.output = await this.runJobBody(job.config);
    } catch (err) {
      run.status = "error";
      run.error = errorMessage(err);
      logger.error(`error ${job.id}`, err);
    } finally {
      run.durationMs = Date.now() - startedMs;
      logger.log(`${job.id} — duration=${(run.durationMs / 1000).toFixed(1)}s`);
      job.running = false;
      job.lastRun = startedAt;
      job.fireCount++;

      try {
        await this.onRunComplete(run);
      } catch (err) {
        logger.error(`onRunComplete failed for ${job.id}`, err);
      }
    }
  }

  /**
   * Dispatch to the injected runner for the job's type.
   */
  private runJobBody(config: JobConfig): Promise<string> {
    switch (config.type) {
      case "agent":
        return this.runAgent({
          jobId: config.id,
          prompt: config.prompt,
          model: config.model ?? undefined,
          thinking: config.thinking,
          timeoutMs: config.timeout ? config.timeout * 1_000 : undefined,
        });
      case "script":
        return this.runScript({
          jobId: config.id,
          command: config.command,
          timeoutMs: (config.timeout ?? DEFAULT_SCRIPT_TIMEOUT) * 1_000,
        });
      default:
        throw new Error(`Unknown job type: ${(config as { type: string }).type}`);
    }
  }

  /**
   * Arm a job's croner timer.
   */
  private startJobTimer(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !job.config.enabled) return;

    try {
      job.cron?.stop();
      job.cron = new Croner(job.config.schedule, () => this.fireJob(id));
    } catch (err) {
      logger.error(`failed to start job ${id}`, err);
    }
  }

  /**
   * Disarm a job's timer (no-op if not armed).
   */
  private stopJobTimer(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cron?.stop();
    job.cron = null;
  }

  /**
   * Build a ScheduledJob from a config with no timer armed. The schedule was validated by the
   * loader (invalid files never reach here).
   */
  private buildLoadedJob(config: JobConfig): ScheduledJob {
    return {
      id: config.id,
      config,
      cron: null,
      running: false,
      lastRun: null,
      fireCount: 0,
    };
  }
}
