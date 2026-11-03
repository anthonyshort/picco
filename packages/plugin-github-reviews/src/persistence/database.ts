import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Open the shared review database and preserve the supported polling schema.
 */
export function openReviewDatabase(filename: string): DatabaseSync {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  try {
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    const existing = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (existing) {
      const versions = database.prepare("SELECT version FROM schema_migrations").all();
      if (
        versions.length !== 1 ||
        !z.object({ version: z.literal(1) }).safeParse(versions[0]).success
      ) {
        throw new Error("Unsupported review database schema; admissions stopped");
      }
    }
    database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
    reviewTransaction(database, () =>
      database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY, reviewer TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, head TEXT NOT NULL, createdAt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','superseded')),
      reason TEXT, requestEventId TEXT, requestedAt TEXT, seenAt INTEGER NOT NULL,
      UNIQUE(reviewer,repository,number,head)
    );
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES review_queue(id), data TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','completed','blocked','interrupted')),
      finishedAt TEXT, reason TEXT, output TEXT, notification TEXT, notificationError TEXT,
      reviewedAt TEXT, reviewSummary TEXT, resolution TEXT, resolutionReason TEXT
    );
    CREATE TABLE IF NOT EXISTS review_claims (
      repository TEXT NOT NULL, number INTEGER NOT NULL, runId TEXT NOT NULL UNIQUE REFERENCES review_runs(id),
      expiresAt INTEGER NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(repository,number)
    );
    CREATE TABLE IF NOT EXISTS reviewed_commits (
      reviewer TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL,
      requestEventId TEXT NOT NULL DEFAULT '', reviewedAt TEXT NOT NULL,
      runId TEXT REFERENCES review_runs(id), summary TEXT,
      PRIMARY KEY(reviewer,repository,number,head,requestEventId)
    );

    CREATE TABLE IF NOT EXISTS explicit_review_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS explicit_review_attempts(
      id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES explicit_review_jobs(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS explicit_review_requests(
      requestId TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES explicit_review_jobs(id), url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_results(runId TEXT PRIMARY KEY, data TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS poller_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS queue_order ON review_queue(status,createdAt,repository,number);
    INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
  `),
    );

    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}

/**
 * Keep each persistence operation atomic on the shared review connection.
 */
export function reviewTransaction<Result>(database: DatabaseSync, operation: () => Result): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}
