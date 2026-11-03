import { type z } from "zod";
import { type JobRepository } from "../persistence/job-repository.js";
import { JobFinishSchema, ReviewResultCaptureSchema } from "./types.js";

/**
 * Bound saved workflow evidence and diagnostic previews independently.
 */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 12_000;

/**
 * Record worker evidence, teardown and notification outcomes without SQL knowledge.
 */
export class JobAttempts {
  constructor(
    private readonly repository: JobRepository,
    private readonly timestamp: () => string,
  ) {}

  capture(runId: string, input: z.infer<typeof ReviewResultCaptureSchema>): void {
    const checked = ReviewResultCaptureSchema.parse(input);
    const data = JSON.stringify(checked);
    if (Buffer.byteLength(data) > MAX_RESULT_BYTES) throw new Error("Review result exceeds 4 MiB");
    this.repository.transaction(() => {
      const previous = this.repository.readCapture(runId);
      if (previous) {
        if (JSON.stringify(previous) !== data) throw new Error("Review result already captured");
        return;
      }
      this.repository.saveCapture(runId, checked);
    });
  }

  result(runId: string) {
    return this.repository.readCapture(runId);
  }

  markReviewed(runId: string, summary: string): boolean {
    const run = this.repository.readRun(runId);
    if (!run || run.status !== "running") return false;
    this.repository.saveRun({
      ...run,
      reviewedAt: run.reviewedAt ?? this.timestamp(),
      reviewSummary: run.reviewSummary ?? summary,
    });
    return true;
  }

  finish(runId: string, input: z.infer<typeof JobFinishSchema>): void {
    const outcome = JobFinishSchema.parse(input);
    this.repository.transaction(() => {
      const run = this.repository.readRun(runId);
      if (!run) throw new Error("Unknown review attempt");
      if (run.status !== "running") return;
      if (outcome.status === "completed" && !run.reviewedAt)
        throw new Error("Review completion has not been declared");
      const job = this.repository.readJob(run.jobId)!;
      this.repository.saveRun({
        ...run,
        reason: outcome.abandoned && !run.reviewedAt ? "runtime-restarted" : outcome.reason,
        status: run.reviewedAt ? "completed" : outcome.status,
        output: outcome.output?.slice(0, MAX_OUTPUT_CHARACTERS),
        finishedAt: outcome.finishedAt ?? this.timestamp(),
      });
      this.repository.saveJob({
        ...job,
        status: run.reviewedAt ? "completed" : outcome.abandoned ? "queued" : outcome.status,
      });
    });
  }

  recordNotificationAttempt(runId: string): boolean {
    return this.repository.transaction(() => {
      const run = this.repository.readRun(runId);
      if (!run || run.status === "running" || run.notification) return false;
      this.repository.saveRun({ ...run, notification: "attempted" });
      return true;
    });
  }

  completeNotification(
    runId: string,
    status: "confirmed" | "failed" | "uncertain",
    error?: string,
  ): void {
    const run = this.repository.readRun(runId);
    if (run?.notification === "attempted")
      this.repository.saveRun({ ...run, notification: status, notificationError: error });
  }
}
