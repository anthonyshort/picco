import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { JobRepository } from "../persistence/job-repository.js";
import { openReviewDatabase } from "./database.js";
import { PollingRepository } from "./polling-repository.js";

/**
 * Both repositories participate in the same SQLite transaction.
 */
describe("PollingRepository", () => {
  test("commits or rolls back polling state and captured results together", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "picco-review-repositories-"));
    const database = openReviewDatabase(path.join(directory, "reviews.sqlite"));
    const polling = new PollingRepository(database);
    const jobs = new JobRepository(database);
    const captured = { complete: false, value: { evidence: "Partial review" } };
    try {
      expect(() =>
        polling.transaction(() => {
          polling.writeState("paused", true);
          jobs.saveCapture("polling-run", captured);
          throw new Error("Persistence failed before commit");
        }),
      ).toThrow("Persistence failed before commit");
      expect(polling.readState("paused")).toBeNull();
      expect(jobs.readCapture("polling-run")).toBeNull();
      polling.transaction(() => {
        polling.writeState("paused", true);
        jobs.saveCapture("polling-run", captured);
      });
      expect(polling.readState("paused")).toBe(true);
      expect(jobs.readCapture("polling-run")).toEqual(captured);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back failed writes on the shared database", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "picco-polling-repository-"));
    const database = openReviewDatabase(path.join(directory, "reviews.sqlite"));
    const repository = new PollingRepository(database);
    try {
      expect(() =>
        repository.transaction(() => {
          repository.writeState("paused", true);
          throw new Error("State write failed");
        }),
      ).toThrow("State write failed");
      expect(repository.readState("paused")).toBeNull();
      repository.transaction(() => repository.writeState("paused", true));
      expect(repository.readState("paused")).toBe(true);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "explicit_review_attempts",
        "explicit_review_jobs",
        "explicit_review_requests",
        "poller_state",
        "review_claims",
        "review_queue",
        "review_results",
        "review_runs",
        "reviewed_commits",
        "schema_migrations",
      ]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
