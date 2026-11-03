import { openReviewDatabase } from "./database.js";
import { describe, expect, test } from "vitest";
import { JobRepository } from "./job-repository.js";
import { JobSchema } from "../jobs/types.js";

/**
 * A persisted job with independently chosen immutable request metadata.
 */
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
  status: "queued",
});

describe("JobRepository", () => {
  test("rolls back job and receipt changes together when a later write fails", () => {
    const database = openReviewDatabase(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    const repository = new JobRepository(database);
    try {
      repository.transaction(() => {
        repository.saveJob(job);
        repository.addReceipt(job.requestId, job);
      });
      const another = { ...job, id: "job-two", requestId: "request-two" };
      expect(() =>
        repository.transaction(() => {
          repository.saveJob(another);
          repository.addReceipt(another.requestId, another);
          repository.addReceipt(job.requestId, another);
        }),
      ).toThrow();
      expect(repository.jobs()).toEqual([job]);
      expect(repository.readJob(another.id)).toBeNull();
      expect(repository.receipt(another.requestId)).toBeNull();
      expect(repository.receipt(job.requestId)).toEqual({ jobId: job.id, url: job.url });
    } finally {
      database.close();
    }
  });

  test("validates persisted records before returning them to lifecycle policy", () => {
    const database = openReviewDatabase(":memory:");
    const repository = new JobRepository(database);
    try {
      database
        .prepare("INSERT INTO explicit_review_jobs(id,data) VALUES (?,?)")
        .run(job.id, JSON.stringify({ ...job, status: "unexpected" }));
      expect(() => repository.readJob(job.id)).toThrow();
      expect(() => repository.jobs()).toThrow();
    } finally {
      database.close();
    }
  });
});
