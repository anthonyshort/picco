import { randomUUID } from "node:crypto";
import { CronHistory, type JobRunRecord } from "./history.js";
import { Cron as Croner } from "croner";
import type { Cron } from "croner";
import isEqual from "fast-deep-equal";
import {
  createLogger,
  errorMessage,
  ExecutionFailure,
  type ThinkingLevel,
  type Logger,
} from "@picco-agent/core";
import type { JobConfig, JobConfigInput, JobConfigUpdate, JobLoader } from "./loader.js";

const DEFAULT_SCRIPT_TIMEOUT = 300; // seconds
/**
 * Shutdown returns control while unresolved work retains its history lock.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * In-memory state for a loaded job, including its armed timer and run counters.
 */
interface ScheduledJob {
  id: string;
  config: JobConfig;
  cron: Cron | null;
  execution: JobExecutionState;
}

/**
 * Execution counters retained when a job configuration or timer is replaced.
 */
interface JobExecutionState {
  activeCount: number;
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
  description: string;
  type: JobConfig["type"];
  schedule: string;
  enabled: boolean;
  maxConcurrentRuns: number;
  activeCount: number;
  /**
   * Executions still awaiting their body/finalisation; observers can retain capacity afterward.
   */
  runningCount: number;
  lastRun: string | null;
  fireCount: number;
  /**
   * Latest retained trigger outcome, including interrupted or skipped work.
   */
  latestRun?: JobRunRecord;
}

/**
 * One completed run's outcome — handed to CronOptions.onRunComplete.
 */
export interface JobRun {
  /**
   * Stable cron run identity, present on scheduler-generated reports.
   */
  id?: string;
  /**
   * Picco execution identity when the agent runner exposes one.
   */
  executionId?: string;
  jobId: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "error";
  /**
   * The agent's final text, or the script's combined output.
   */
  output?: string;
  error?: string;
  /**
   * Critical cleanup failures reported by Picco, separate from the original model error.
   */
  finalisationErrors?: string[];
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
  /**
   * Associate a live model execution before awaiting its completion.
   */
  reportExecution?: (executionId: string) => void;
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
  /**
   * Plugin-owned history; raw scheduler consumers may omit it for in-memory use.
   */
  history?: CronHistory;
  logger?: Logger;
  loader: JobLoader;
  runAgent: RunAgent;
  runScript: RunScript;
  onRunComplete: OnRunComplete;
}

/**
 * Arms croner timers for loaded jobs, fires them with bounded concurrency, and reports every
 * completed run to the injected onRunComplete hook after persisting its outcome. Injected runners
 * keep scheduling independent of the agent runtime.
 */
export class JobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private executions = new Map<string, JobExecutionState>();
  private readonly history: CronHistory;
  private readonly active = new Map<string, JobRunRecord>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private readonly logger: Logger;
  private readonly loader: JobLoader;
  private readonly runAgent: RunAgent;
  private readonly runScript: RunScript;
  private readonly onRunComplete: OnRunComplete;

  constructor(options: JobSchedulerOptions) {
    this.history = options.history ?? new CronHistory();
    this.logger = options.logger ?? createLogger("job-scheduler");
    this.loader = options.loader;
    this.runAgent = options.runAgent;
    this.runScript = options.runScript;
    this.onRunComplete = options.onRunComplete;
  }

  /**
   * List current process activity with latest retained outcomes; completed counters are restored
   * from bounded history at startup and are not lifetime totals.
   */
  listJobs(): JobState[] {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      description: job.config.description,
      type: job.config.type,
      schedule: job.config.schedule,
      enabled: job.config.enabled,
      maxConcurrentRuns: job.config.maxConcurrentRuns,
      activeCount: job.execution.activeCount,
      runningCount: [...this.active.values()].filter((run) => run.jobId === job.id).length,
      lastRun: job.execution.lastRun,
      fireCount: job.execution.fireCount,
      latestRun: this.history.list(job.id)[0],
    }));
  }

  /**
   * Inspect active work and retained runs, including jobs removed from the schedule.
   */
  details(id: string, limit = 10, offset = 0) {
    const definition = this.jobs.get(id)?.config;
    const recentRuns = this.history.list(id);
    const activeRuns = [...this.active.values()].filter((run) => run.jobId === id);
    return {
      found: Boolean(definition || recentRuns.length || activeRuns.length),
      id,
      scheduled: Boolean(definition),
      definition: definition ? structuredClone(definition) : null,
      current: this.listJobs().find((job) => job.id === id) ?? null,
      activeRuns: activeRuns.map((run) => structuredClone(run)),
      recentRuns: recentRuns.slice(offset, offset + limit),
      totalRuns: recentRuns.length,
      nextOffset: offset + limit < recentRuns.length ? offset + limit : null,
    };
  }

  /**
   * List retained history without interpreting it as current process activity.
   */
  recentRuns(limit = 20, offset = 0): JobRunRecord[] {
    return this.history.list().slice(offset, offset + limit);
  }

  /**
   * Stop admission and wait for already-owned runs before releasing the history store.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopAllTimers();
    const settled = Promise.allSettled(this.pending).then(() => this.history.close());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Cron shutdown timed out; pending work retains history ownership")),
            SHUTDOWN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Add a job by writing its YAML file, then reload to arm it. Throws if the id is already loaded —
   * silently overwriting would leave the old timer armed with the old config.
   */
  async addJob(config: JobConfigInput): Promise<void> {
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
    if (this.stopped) return "Cron scheduler is stopped.";
    if (!job.config.enabled) {
      this.recordSkipped(job.config, "Job is disabled");
      return `Job "${id}" is disabled.`;
    }
    if (job.execution.activeCount >= job.config.maxConcurrentRuns) {
      this.recordSkipped(job.config, "Concurrency limit reached");
      return `Job "${id}" skipped — concurrency limit ${job.config.maxConcurrentRuns} reached.`;
    }
    this.fireJob(id).catch((err) => {
      this.logger.error(`triggered run failed for ${id}`, err);
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
    const newConfigs = await this.loader.refresh();

    // Jobs on disk
    for (const [id, config] of newConfigs) {
      const prev = this.jobs.get(id);
      const prevConfig = prev?.config;

      if (!prev || !prevConfig) {
        // New job — build and arm if enabled
        this.jobs.set(id, this.buildLoadedJob(config));
        if (config.enabled) this.startJobTimer(id);
        this.logger.log(`loaded ${id}`);
      } else if (!isEqual(prevConfig, config)) {
        // Changed — disarm old, build new, arm if enabled
        this.stopJobTimer(id);
        this.jobs.set(id, this.buildLoadedJob(config));
        if (config.enabled) this.startJobTimer(id);
        this.logger.log(`reloaded ${id}`);
      }
    }

    // Jobs in memory but gone from disk — stop and remove
    for (const id of [...this.jobs.keys()]) {
      if (!newConfigs.has(id)) {
        this.stopJobTimer(id);
        this.jobs.delete(id);
        this.logger.log(`removed job ${id}`);
      }
    }
  }

  /**
   * Run one job to completion, within its concurrency limit; the outcome goes to onRunComplete. A
   * no-op for an id that is no longer loaded (a timer can fire in the same tick its job is
   * removed).
   */
  fireJob(id: string): Promise<void> {
    const operation = this.executeJob(id);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  /**
   * Persist admission and terminal results independently of completion observers.
   */
  private async executeJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (this.stopped || !job || !job.config.enabled) return;
    const config = structuredClone(job.config);
    const execution = job.execution;
    if (execution.activeCount >= config.maxConcurrentRuns) {
      this.recordSkipped(config, "Concurrency limit reached");
      this.logger.log(`${job.id} skipped (concurrency limit reached)`);
      return;
    }
    const startedMs = Date.now();
    const record = this.createRecord(config, "running");
    execution.activeCount++;
    try {
      this.history.save(record);
      this.active.set(record.id, record);
      this.logger.log(`Starting ${job.id} (${config.type})`);
      const run: JobRun = {
        id: record.id,
        jobId: job.id,
        startedAt: record.startedAt,
        durationMs: 0,
        status: "success",
      };
      try {
        run.output = await this.runJobBody(config, (executionId) => {
          record.executionId = executionId;
          run.executionId = executionId;
          this.history.save(record);
        });
      } catch (err) {
        run.status = "error";
        run.error = errorMessage(err);
        if (err instanceof ExecutionFailure) {
          run.finalisationErrors = err.finalisationErrors
            .slice(0, 100)
            .map((failure) => errorMessage(failure).slice(0, 1_000));
        }
        this.logger.error(`error ${job.id}`, err);
      }
      run.durationMs = Math.max(0, Date.now() - startedMs);
      this.history.save({ ...record, ...run, id: record.id, finishedAt: new Date().toISOString() });
      this.active.delete(record.id);
      execution.lastRun = run.startedAt;
      execution.fireCount++;
      this.logger.log(`${job.id} — duration=${(run.durationMs / 1000).toFixed(1)}s`);
      try {
        await this.onRunComplete(run);
      } catch (err) {
        this.logger.error(`onRunComplete failed for ${job.id}`, err);
      }
    } finally {
      this.active.delete(record.id);
      execution.activeCount--;
    }
  }

  /**
   * Record a rejected trigger without running its body or incrementing completion counters.
   */
  private recordSkipped(config: JobConfig, reason: string): void {
    const run = this.createRecord(config, "skipped");
    this.history.save({ ...run, finishedAt: run.startedAt, reason });
  }

  /**
   * Snapshot the selected configuration before a later edit can change its meaning.
   */
  private createRecord(config: JobConfig, status: JobRunRecord["status"]): JobRunRecord {
    return {
      id: randomUUID(),
      jobId: config.id,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status,
      definition: {
        description: config.description.slice(0, 1_000),
        schedule: config.schedule.slice(0, 200),
        type: config.type,
        timeout: config.timeout,
        ...(config.type === "agent"
          ? { model: config.model?.slice(0, 500), thinking: config.thinking }
          : {}),
      },
    };
  }

  /**
   * Dispatch to the injected runner for the job's type.
   */
  private runJobBody(
    config: JobConfig,
    reportExecution: (executionId: string) => void,
  ): Promise<string> {
    switch (config.type) {
      case "agent":
        return this.runAgent({
          jobId: config.id,
          prompt: config.prompt,
          reportExecution,
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
      job.cron = new Croner(job.config.schedule, () => {
        void this.fireJob(id).catch((err) =>
          this.logger.error(`scheduled run failed for ${id}`, err),
        );
      });
    } catch (err) {
      this.logger.error(`failed to start job ${id}`, err);
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
    let execution = this.executions.get(config.id);
    if (!execution) {
      const completed = this.history
        .list(config.id)
        .filter((run) => run.status === "success" || run.status === "error");
      execution = {
        activeCount: 0,
        lastRun: completed[0]?.startedAt ?? null,
        fireCount: completed.length,
      };
      this.executions.set(config.id, execution);
    }
    return {
      id: config.id,
      config,
      cron: null,
      execution,
    };
  }
}
