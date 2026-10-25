import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod";

/**
 * Hard caps bound validated configuration and persisted values consistently.
 */
const MAX_RECORDS = 10_000;
const MAX_OUTPUT_CHARS = 16_384;
/**
 * Bound stored history and the scheduler’s default query page.
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
  jobId: z.string().min(1),
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
 * Store run metadata in one database, with one scheduler owning it until close.
 */
export class CronHistory {
  private readonly database: DatabaseSync;
  private readonly options: z.output<typeof HistoryOptionsSchema>;
  private closed = false;

  constructor(opts: HistoryStoreOptions = {}) {
    this.options = HistoryOptionsSchema.parse(opts.history ?? {});
    if (opts.file) mkdirSync(path.dirname(opts.file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(opts.file ?? ":memory:");
    try {
      if (opts.file) chmodSync(opts.file, 0o600);
      this.database.exec(`
        PRAGMA locking_mode = EXCLUSIVE;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          jobId TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          finishedAt TEXT,
          durationMs REAL NOT NULL,
          status TEXT NOT NULL,
          definition TEXT NOT NULL,
          executionId TEXT,
          output TEXT,
          error TEXT,
          reason TEXT,
          outputTruncated INTEGER,
          finalisationErrors TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_started ON runs(startedAt DESC);
        CREATE INDEX IF NOT EXISTS runs_job_started ON runs(jobId, startedAt DESC);
      `);
      const now = new Date().toISOString();
      this.database
        .prepare(`
        UPDATE runs SET status = 'interrupted', finishedAt = ?,
          durationMs = MAX(0, (julianday(?) - julianday(startedAt)) * 86400000),
          reason = 'The previous scheduler stopped before recording completion; external outcomes may be unknown.'
        WHERE status = 'running'
      `)
        .run(now, now);
      this.prune();
      this.database.exec("COMMIT");
    } catch (err) {
      this.database.close();
      throw err;
    }
  }

  /**
   * Read only the requested page, newest first, optionally restricted to one job.
   */
  list(jobId?: string, limit = this.options.maxRecords, offset = 0): JobRunRecord[] {
    const query = this.database.prepare(`
      SELECT * FROM runs ${jobId === undefined ? "" : "WHERE jobId = ?"}
      ORDER BY startedAt DESC, rowid DESC LIMIT ? OFFSET ?
    `);
    const rows = jobId === undefined ? query.all(limit, offset) : query.all(jobId, limit, offset);
    return rows.map(readRun);
  }

  /**
   * Count retained runs without loading their output or definition snapshots.
   */
  count(jobId?: string): number {
    const query = this.database.prepare(
      `SELECT count(*) AS count FROM runs ${jobId === undefined ? "" : "WHERE jobId = ?"}`,
    );
    return z
      .object({ count: z.number() })
      .parse(jobId === undefined ? query.get() : query.get(jobId)).count;
  }

  /**
   * Restore completion counters without treating skipped or interrupted runs as completed work.
   */
  completed(jobId: string) {
    return z.object({ fireCount: z.number(), lastRun: z.string().nullable() }).parse(
      this.database
        .prepare(`
        SELECT count(*) AS fireCount, max(startedAt) AS lastRun FROM runs
        WHERE jobId = ? AND status IN ('success', 'error')
      `)
        .get(jobId),
    );
  }

  /**
   * Commit a run transition and retention changes before starting work or reporting completion.
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
        INSERT INTO runs (
          id, jobId, startedAt, finishedAt, durationMs, status, definition,
          executionId, output, error, reason, outputTruncated, finalisationErrors
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          jobId = excluded.jobId, startedAt = excluded.startedAt,
          finishedAt = excluded.finishedAt, durationMs = excluded.durationMs,
          status = excluded.status, definition = excluded.definition,
          executionId = excluded.executionId, output = excluded.output,
          error = excluded.error, reason = excluded.reason,
          outputTruncated = excluded.outputTruncated, finalisationErrors = excluded.finalisationErrors
      `)
        .run(
          run.id,
          run.jobId,
          run.startedAt,
          run.finishedAt ?? null,
          run.durationMs,
          run.status,
          JSON.stringify(run.definition),
          run.executionId ?? null,
          run.output ?? null,
          run.error ?? null,
          run.reason ?? null,
          run.outputTruncated === undefined ? null : Number(run.outputTruncated),
          run.finalisationErrors === undefined ? null : JSON.stringify(run.finalisationErrors),
        );
      this.prune();
      this.database.exec("COMMIT");
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Close after active work settles; SQLite releases ownership even after a process crash.
   */
  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  /**
   * Keep running work while bounding completed history by age and record count.
   */
  private prune(): void {
    const cutoff = new Date(Date.now() - this.options.retentionDays * 86_400_000).toISOString();
    this.database
      .prepare(`
      DELETE FROM runs WHERE status != 'running' AND coalesce(finishedAt, startedAt) < ?
    `)
      .run(cutoff);
    const { count } = z
      .object({ count: z.number() })
      .parse(
        this.database.prepare("SELECT count(*) AS count FROM runs WHERE status = 'running'").get(),
      );
    if (count > this.options.maxRecords)
      throw new Error("Cron history active-record capacity reached");
    this.database
      .prepare(`
      DELETE FROM runs WHERE status != 'running' AND id NOT IN (
        SELECT id FROM runs WHERE status != 'running'
        ORDER BY startedAt DESC, rowid DESC LIMIT ?
      )
    `)
      .run(this.options.maxRecords - count);
  }
}

/**
 * Decode the two structured columns and SQLite nulls before validating the run shape.
 */
function readRun(input: unknown): JobRunRecord {
  const row = z.record(z.string(), z.unknown()).parse(input);
  return JobRunRecordSchema.parse({
    ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? undefined])),
    definition: JSON.parse(z.string().parse(row.definition)),
    finalisationErrors:
      row.finalisationErrors === null
        ? undefined
        : JSON.parse(z.string().parse(row.finalisationErrors)),
    outputTruncated: row.outputTruncated === null ? undefined : Boolean(row.outputTruncated),
  });
}
