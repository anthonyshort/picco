import { type DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { reviewTransaction } from "./database.js";
import {
  JobSchema,
  JobRunSchema,
  ReviewResultCaptureSchema,
  type Job,
  type JobRun,
  type ReviewResultCapture,
} from "../jobs/types.js";

/**
 * Durable receipt connecting one external request to its job and target URL.
 */
const RequestReceiptSchema = z.object({ jobId: z.string(), url: z.url() });

/**
 * Keep SQLite queries and serialisation outside review lifecycle policy.
 */
export class JobRepository {
  constructor(private readonly database: DatabaseSync) {}

  transaction<Result>(operation: () => Result): Result {
    return reviewTransaction(this.database, operation);
  }

  readJob(id: string): Job | null {
    const row = this.database.prepare("SELECT data FROM explicit_review_jobs WHERE id=?").get(id);
    return row ? JobSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  readRun(id: string): JobRun | null {
    const row = this.database
      .prepare("SELECT data FROM explicit_review_attempts WHERE id=?")
      .get(id);
    return row ? JobRunSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  saveJob(job: Job): Job {
    this.database
      .prepare(
        "INSERT INTO explicit_review_jobs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
    return job;
  }

  saveRun(run: JobRun): void {
    this.database
      .prepare(
        "INSERT INTO explicit_review_attempts(id,jobId,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, run.jobId, JSON.stringify(run));
  }

  jobs(): Job[] {
    return this.database
      .prepare("SELECT data FROM explicit_review_jobs ORDER BY rowid")
      .all()
      .map((row) => JobSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  runs(jobId: string): JobRun[] {
    return this.database
      .prepare("SELECT data FROM explicit_review_attempts WHERE jobId=? ORDER BY rowid")
      .all(jobId)
      .map((row) => JobRunSchema.parse(JSON.parse(z.string().parse(row.data))));
  }

  receipt(requestId: string) {
    const row = this.database
      .prepare("SELECT jobId,url FROM explicit_review_requests WHERE requestId=?")
      .get(requestId);
    return row ? RequestReceiptSchema.parse(row) : null;
  }

  addReceipt(requestId: string, job: Job): void {
    this.database
      .prepare("INSERT INTO explicit_review_requests(requestId,jobId,url) VALUES (?,?,?)")
      .run(requestId, job.id, job.url);
  }

  readCapture(runId: string): ReviewResultCapture | null {
    const row = this.database.prepare("SELECT data FROM review_results WHERE runId=?").get(runId);
    return row ? ReviewResultCaptureSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  saveCapture(runId: string, capture: ReviewResultCapture): void {
    this.database
      .prepare("INSERT INTO review_results(runId,data) VALUES (?,?)")
      .run(runId, JSON.stringify(capture));
  }
}
