import { openReviewDatabase } from "../persistence/database.js";
import { describe, expect, test } from "vitest";
import { JobAttempts } from "./attempts.js";
import { JobRepository } from "../persistence/job-repository.js";
import { JobSchema, JobRunSchema } from "./types.js";

/**
 * Running attempt persisted through the real repository.
 */
function fixture() {
  const database = openReviewDatabase(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const repository = new JobRepository(database);
  const job = JobSchema.parse({
    id: "job-one",
    requestId: "request-one",
    source: "mcp",
    delivery: "local-only",
    base: "b".repeat(40),
    head: "a".repeat(40),
    repository: "example/project",
    number: 42,
    title: "Change",
    url: "https://github.com/example/project/pull/42",
    reviewer: "reviewer",
    skill: "review",
    createdAt: "2026-10-01T00:00:00Z",
    queuedAt: "2026-11-02T00:00:00Z",
    status: "running",
  });
  const run = JobRunSchema.parse({
    ...job,
    id: "run-one",
    jobId: job.id,
    itemId: job.id,
    startedAt: job.queuedAt,
    sessionKey: "worker-one",
  });
  repository.saveJob(job);
  repository.saveRun(run);
  const attempts = new JobAttempts(repository, () => "2026-11-02T01:00:00Z");
  return { database, repository, job, run, attempts };
}

describe("JobAttempts", () => {
  test("rejects completion without a declaration and leaves both persisted states running", () => {
    const { database, repository, job, run, attempts } = fixture();
    try {
      expect(() => attempts.finish(run.id, { status: "completed" })).toThrow("not been declared");
      expect(repository.readRun(run.id)).toEqual(run);
      expect(repository.readJob(job.id)).toEqual(job);
      expect(attempts.markReviewed(run.id, "Review complete")).toBe(true);
      attempts.finish(run.id, { status: "completed" });
      expect(repository.readRun(run.id)).toMatchObject({
        status: "completed",
        reviewSummary: "Review complete",
      });
      expect(repository.readJob(job.id)?.status).toBe("completed");
    } finally {
      database.close();
    }
  });

  test("keeps full partial evidence immutable and bounds it independently from output previews", () => {
    const { database, run, attempts } = fixture();
    try {
      const capture = { complete: false, value: { report: "evidence".repeat(3000) } };
      attempts.capture(run.id, capture);
      attempts.capture(run.id, capture);
      expect(attempts.result(run.id)).toEqual(capture);
      expect(() =>
        attempts.capture(run.id, { complete: true, value: { report: "replacement" } }),
      ).toThrow("already captured");
      expect(() =>
        attempts.capture("oversized", { complete: true, value: "x".repeat(4 * 1024 * 1024) }),
      ).toThrow("exceeds 4 MiB");
      expect(attempts.result("oversized")).toBeNull();
    } finally {
      database.close();
    }
  });

  test.each([true, false])(
    "only shutdown abandonment queues a fresh attempt: abandoned=%s",
    (abandoned) => {
      const { database, repository, job, run, attempts } = fixture();
      try {
        attempts.finish(run.id, { status: "interrupted", reason: "Worker failed", abandoned });
        expect(repository.readJob(job.id)?.status).toBe(abandoned ? "queued" : "interrupted");
        expect(repository.readRun(run.id)?.reason).toBe(
          abandoned ? "runtime-restarted" : "Worker failed",
        );
      } finally {
        database.close();
      }
    },
  );

  test("notifies only after a stopped attempt and records one delivery outcome", () => {
    const { database, repository, run, attempts } = fixture();
    try {
      expect(attempts.recordNotificationAttempt(run.id)).toBe(false);
      attempts.finish(run.id, { status: "blocked" });
      expect(attempts.recordNotificationAttempt(run.id)).toBe(true);
      expect(attempts.recordNotificationAttempt(run.id)).toBe(false);
      attempts.completeNotification(run.id, "uncertain", "Delivery outcome unknown");
      attempts.completeNotification(run.id, "confirmed");
      expect(repository.readRun(run.id)).toMatchObject({
        notification: "uncertain",
        notificationError: "Delivery outcome unknown",
      });
    } finally {
      database.close();
    }
  });
});
