import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Legacy histories need an explicitly reviewed conversion before this model can adopt them.
 */
const LEGACY_TABLES = [
  "review_queue",
  "review_runs",
  "review_claims",
  "reviewed_commits",
  "poller_state",
];

/**
 * Own one connection and initialise only the two accepted-work tables.
 */
export function openReviewDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  try {
    for (const table of LEGACY_TABLES) {
      if (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) &&
        database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
      )
        throw new Error(
          "Legacy review history requires a reviewed migration before starting this plugin. Keep the existing database; do not delete it or use a new empty database to bypass history checks.",
        );
    }
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS review_jobs (
        id TEXT PRIMARY KEY, requestKey TEXT UNIQUE, source TEXT NOT NULL,
        repository TEXT NOT NULL, number INTEGER NOT NULL, reviewer TEXT NOT NULL,
        status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_attempts (
        id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES review_jobs(id),
        attempt INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(jobId,attempt)
      );
      CREATE INDEX IF NOT EXISTS review_job_queue ON review_jobs(status);
      CREATE INDEX IF NOT EXISTS review_job_cycles ON review_jobs(source,reviewer,repository,number);
      COMMIT;
    `);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}
