import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as z from "zod";

/**
 * Bound the persisted snapshot before parsing untrusted or damaged state.
 */
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/**
 * Hard caps bound validated configuration and persisted values consistently.
 */
const MAX_RECORDS = 10_000;
const MAX_OUTPUT_CHARS = 16_384;
/**
 * History configuration also bounds in-memory scheduler use.
 */
const HistoryOptionsSchema = z.object({
  maxRecords: z.number().int().min(1).max(MAX_RECORDS).default(1_000),
  retentionDays: z.number().int().min(1).max(365).default(30),
  maxOutputChars: z.number().int().min(0).max(MAX_OUTPUT_CHARS).default(8_192),
});
/**
 * A safe definition snapshot excludes prompt and command bodies from run metadata.
 */
const DefinitionSnapshotSchema = z.object({
  description: z.string().max(1_000),
  schedule: z.string().max(200),
  type: z.enum(["agent", "script"]),
  timeout: z.number().optional(),
  model: z.string().max(500).optional(),
  thinking: z.string().max(50).optional(),
});
/**
 * Every trigger has a separate record; skipped triggers never represent active work.
 */
export const JobRunRecordSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  durationMs: z.number().nonnegative(),
  status: z.enum(["running", "success", "error", "interrupted", "skipped"]),
  definition: DefinitionSnapshotSchema,
  executionId: z.string().max(200).optional(),
  output: z.string().max(MAX_OUTPUT_CHARS).optional(),
  error: z.string().max(MAX_OUTPUT_CHARS).optional(),
  reason: z.string().max(500).optional(),
  outputTruncated: z.boolean().optional(),
  finalisationErrors: z.array(z.string().max(1_000)).max(100).optional(),
});
/**
 * Persisted cron run metadata, independent of a model session's lifetime.
 */
export type JobRunRecord = z.infer<typeof JobRunRecordSchema>;
/**
 * Bounded history settings; the plugin persists under its private data directory by default.
 */
export type CronHistoryOptions = z.input<typeof HistoryOptionsSchema>;
/**
 * Store construction options used by the scheduler and persistence tests.
 */
interface HistoryStoreOptions {
  file?: string;
  history?: CronHistoryOptions;
}
/**
 * Atomic snapshots make each persisted transition visible in full.
 */
const HistoryFileSchema = z.object({
  version: z.literal(1),
  runs: z.array(JobRunRecordSchema).max(MAX_RECORDS),
});

/**
 * Own one bounded history snapshot. A file-backed store holds an exclusive process lock.
 */
export class CronHistory {
  private runs: JobRunRecord[] = [];
  private readonly options: z.output<typeof HistoryOptionsSchema>;
  private readonly file?: string;
  private readonly lock?: string;
  private closed = false;

  constructor(opts: HistoryStoreOptions = {}) {
    this.options = HistoryOptionsSchema.parse(opts.history ?? {});
    this.file = opts.file;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.lock = `${this.file}.lock`;
    acquireLock(this.lock);
    try {
      if (existsSync(this.file)) {
        if (statSync(this.file).size > MAX_HISTORY_BYTES)
          throw new Error("Cron history exceeds its size limit");
        this.runs = HistoryFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).runs;
      }
      const now = new Date().toISOString();
      this.runs = this.runs.map((run) =>
        run.status === "running"
          ? {
              ...run,
              status: "interrupted" as const,
              finishedAt: now,
              durationMs: Math.max(0, Date.parse(now) - Date.parse(run.startedAt)),
              reason:
                "The previous scheduler stopped before recording completion; external outcomes may be unknown.",
            }
          : run,
      );
      this.persist(this.runs);
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Return newest records first; callers cannot mutate the stored snapshot.
   */
  list(jobId?: string): JobRunRecord[] {
    return this.runs
      .filter((run) => !jobId || run.jobId === jobId)
      .map((run) => structuredClone(run))
      .reverse();
  }

  /**
   * Commit a run transition before it becomes observable to callers or starts work.
   */
  save(input: JobRunRecord): void {
    if (this.closed) throw new Error("Cron history is closed");
    const run = JobRunRecordSchema.parse({
      ...input,
      output: input.output?.slice(0, this.options.maxOutputChars),
      error: input.error?.slice(0, this.options.maxOutputChars),
      outputTruncated:
        input.outputTruncated ||
        (input.output?.length ?? 0) > this.options.maxOutputChars ||
        (input.error?.length ?? 0) > this.options.maxOutputChars,
    });
    const existing = this.runs.findIndex((entry) => entry.id === run.id);
    const next = this.runs.slice();
    if (existing < 0) next.push(run);
    else next[existing] = run;
    this.persist(next);
  }

  /**
   * Release exclusive ownership after active runs and completion reporting have stopped.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock) unlinkSync(this.lock);
  }

  /**
   * Prune terminal records while retaining active work, then atomically replace the snapshot.
   */
  private persist(input: JobRunRecord[]): void {
    const cutoff = Date.now() - this.options.retentionDays * 86_400_000;
    const retained = input.filter(
      (run) => run.status === "running" || Date.parse(run.finishedAt ?? run.startedAt) >= cutoff,
    );
    const active = retained.filter((run) => run.status === "running");
    if (active.length > this.options.maxRecords)
      throw new Error("Cron history active-record capacity reached");
    const keep = new Set(
      retained
        .filter((run) => run.status !== "running")
        .slice(-(this.options.maxRecords - active.length))
        .map((run) => run.id),
    );
    if (active.length === this.options.maxRecords) keep.clear();
    const next = retained.filter((run) => run.status === "running" || keep.has(run.id));
    if (this.file) {
      const text = JSON.stringify({ version: 1, runs: next }) + "\n";
      if (Buffer.byteLength(text) > MAX_HISTORY_BYTES)
        throw new Error("Cron history exceeds its size limit");
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(descriptor, text);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    this.runs = next;
  }
}

/**
 * Refuse a second live scheduler; reclaim only locks whose owning process has exited.
 */
function acquireLock(file: string): void {
  if (existsSync(file)) {
    const pid = z
      .number()
      .int()
      .positive()
      .safe()
      .parse(Number(readFileSync(file, "utf8")));
    try {
      process.kill(pid, 0);
      throw new Error("Cron history is already open by a live scheduler");
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err;
      unlinkSync(file);
    }
  }
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, String(process.pid));
  } finally {
    closeSync(descriptor);
  }
}
