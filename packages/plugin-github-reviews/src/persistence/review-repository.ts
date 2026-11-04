import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ReviewAttemptSchema,
  ReviewJobSchema,
  type ReviewJob,
  type ReviewAttempt,
} from "../review-types.js";

/**
 * Persist accepted reviews and their attempts on the shared connection.
 */
export class ReviewRepository {
  constructor(private readonly database: DatabaseSync) {}

  transaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }
  }

  saveJob(job: ReviewJob): void {
    const value = ReviewJobSchema.parse(job);
    this.database
      .prepare(`INSERT INTO review_jobs(id,requestKey,source,repository,number,reviewer,status,data)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`)
      .run(
        value.id,
        value.requestKey,
        value.source,
        value.repository,
        value.number,
        value.reviewer,
        value.status,
        JSON.stringify(value),
      );
  }

  job(id: string): ReviewJob | null {
    const row = this.database.prepare("SELECT data FROM review_jobs WHERE id=?").get(id);
    return row ? ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  requested(key: string): ReviewJob | null {
    const row = this.database.prepare("SELECT data FROM review_jobs WHERE requestKey=?").get(key);
    return row ? ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  list(limit: number): ReviewJob[] {
    return this.database
      .prepare("SELECT data FROM review_jobs ORDER BY rowid DESC LIMIT ?")
      .all(limit)
      .map((row) => ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  queued(): ReviewJob[] {
    return this.database
      .prepare("SELECT data FROM review_jobs WHERE status='queued' ORDER BY rowid")
      .all()
      .map((row) => ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  running(): ReviewJob[] {
    return this.database
      .prepare("SELECT data FROM review_jobs WHERE status='running'")
      .all()
      .map((row) => ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  cycles(reviewer: string, repository: string, number: number): ReviewJob[] {
    return this.database
      .prepare(
        "SELECT data FROM review_jobs WHERE source='poll' AND reviewer=? AND repository=? AND number=? ORDER BY rowid DESC",
      )
      .all(reviewer, repository, number)
      .map((row) => ReviewJobSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  saveAttempt(run: ReviewAttempt): void {
    const value = ReviewAttemptSchema.parse(run);
    this.database
      .prepare(
        `INSERT INTO review_attempts(id,jobId,attempt,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, value.itemId, value.attempt, JSON.stringify(value));
  }

  attempts(id: string): ReviewAttempt[] {
    return this.database
      .prepare("SELECT data FROM review_attempts WHERE jobId=? ORDER BY attempt DESC")
      .all(id)
      .map((row) => ReviewAttemptSchema.parse(JSON.parse(z.string().parse(row.data))));
  }
}
