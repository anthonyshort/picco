import { randomUUID } from "node:crypto";
import { type z } from "zod";
import { type JobRepository } from "../persistence/job-repository.js";
import { JobAttempts } from "./attempts.js";
import {
  JobSchema,
  JobRunSchema,
  JobSubmissionSchema,
  JobRetrySchema,
  type Job,
  type JobRun,
} from "./types.js";

/**
 * Apply job admission, retry and recovery rules through typed persistence.
 */
export class JobStore {
  readonly attempts: JobAttempts;

  constructor(
    private readonly repository: JobRepository,
    private readonly now = Date.now,
  ) {
    this.attempts = new JobAttempts(repository, () => this.timestamp());
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private receipt(requestId: string, url: string, jobId?: string) {
    const row = this.repository.receipt(requestId);
    if (!row) return null;
    if (row.url !== url || (jobId && row.jobId !== jobId))
      throw new Error("Request ID already belongs to a different review");
    return this.repository.readJob(row.jobId);
  }

  submit(input: z.infer<typeof JobSubmissionSchema>): Job {
    const value = JobSubmissionSchema.parse(input);
    if (value.url !== value.candidate.url) throw new Error("Review URL does not match candidate");
    return this.repository.transaction(() => {
      const previous = this.receipt(value.requestId, value.url);
      if (previous) {
        if (previous.delivery !== value.delivery)
          throw new Error("Request ID already uses a different delivery policy");
        return previous;
      }
      const { candidate, ...identity } = value;
      const job = this.repository.saveJob(
        JobSchema.parse({
          ...candidate,
          ...identity,
          id: randomUUID(),
          status: "queued",
          queuedAt: this.timestamp(),
        }),
      );
      this.repository.addReceipt(value.requestId, job);
      return job;
    });
  }

  find(id: string) {
    const job =
      this.repository.readJob(id) ??
      (() => {
        const run = this.repository.readRun(id);
        return run ? this.repository.readJob(run.jobId) : null;
      })();
    return job ? { job, runs: this.repository.runs(job.id) } : null;
  }

  lookupRequest(requestId: string, url: string): Job | null {
    return this.receipt(requestId, url);
  }

  list(limit = 100): Job[] {
    return this.repository.jobs().slice(-limit).reverse();
  }

  next(limit = 100): Job[] {
    return this.repository
      .jobs()
      .filter((job) => job.status === "queued")
      .slice(0, limit);
  }

  admit(jobId: string, sessionKey: string): JobRun | null {
    return this.repository.transaction(() => {
      const job = this.repository.readJob(jobId);
      if (!job || job.status !== "queued") return null;
      const run = JobRunSchema.parse({
        ...job,
        id: randomUUID(),
        jobId,
        itemId: jobId,
        sessionKey,
        startedAt: this.timestamp(),
        status: "running",
      });
      this.repository.saveRun(run);
      this.repository.saveJob({ ...job, status: "running" });
      return run;
    });
  }

  refresh(
    jobId: string,
    candidate: z.infer<typeof JobRetrySchema>["candidate"],
    base: string,
  ): void {
    const job = this.repository.readJob(jobId);
    if (!job || job.status !== "queued") return;
    const checked = JobRetrySchema.parse({ candidate, base });
    this.repository.saveJob({ ...job, ...checked.candidate, base: checked.base });
  }

  block(jobId: string, reason: string): void {
    const job = this.repository.readJob(jobId);
    if (job?.status === "queued") this.repository.saveJob({ ...job, status: "blocked", reason });
  }

  runningCount(): number {
    return this.repository.jobs().filter((job) => job.status === "running").length;
  }

  cancelQueued(jobId: string): Job {
    return this.repository.transaction(() => {
      const job = this.repository.readJob(jobId);
      if (!job) throw new Error("Unknown review job");
      if (job.status !== "queued") throw new Error("Review job is not queued");
      return this.repository.saveJob({ ...job, status: "cancelled" });
    });
  }

  retry(jobId: string, input: z.infer<typeof JobRetrySchema>): Job {
    const value = JobRetrySchema.parse(input);
    return this.repository.transaction(() => {
      const job = this.repository.readJob(jobId);
      if (!job) throw new Error("Unknown review job");
      if (value.candidate.url !== job.url)
        throw new Error("Retry must target the same pull request");
      if (value.requestId) {
        const previous = this.receipt(value.requestId, job.url, jobId);
        if (previous) return previous;
      }
      if (["queued", "running", "completed"].includes(job.status))
        throw new Error("Review job cannot be retried in its current state");
      const updated = this.repository.saveJob({
        ...job,
        ...value.candidate,
        base: value.base,
        status: "queued",
        reason: undefined,
        queuedAt: this.timestamp(),
      });
      if (value.requestId) this.repository.addReceipt(value.requestId, updated);
      return updated;
    });
  }

  recoverInterrupted(): void {
    this.repository.transaction(() => {
      for (const job of this.repository.jobs()) {
        if (job.status !== "running") continue;
        for (const run of this.repository.runs(job.id))
          if (run.status === "running")
            this.repository.saveRun({
              ...run,
              status: run.reviewedAt ? "completed" : "interrupted",
              finishedAt: this.timestamp(),
              reason: run.reviewedAt ? undefined : "runtime-restarted",
            });
        const completed = this.repository.runs(job.id).some((run) => run.reviewedAt);
        this.repository.saveJob({ ...job, status: completed ? "completed" : "queued" });
      }
    });
  }
}
