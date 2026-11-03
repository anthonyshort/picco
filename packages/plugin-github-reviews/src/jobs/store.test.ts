import { openReviewDatabase } from "../persistence/database.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { JobRepository } from "../persistence/job-repository.js";
import { JobStore } from "./store.js";
import { createReviewStore } from "../store.js";

/**
 * One independently pinned explicit review request.
 */
const submission = {
  requestId: "request-1",
  url: "https://github.com/example/project/pull/42",
  source: "mcp" as const,
  delivery: "local-only" as const,
  base: "b".repeat(40),
  reviewer: "reviewer",
  skill: "review",
  candidate: {
    repository: "example/project",
    number: 42,
    title: "Change",
    url: "https://github.com/example/project/pull/42",
    head: "a".repeat(40),
    createdAt: "2026-10-01T00:00:00Z",
  },
};

/**
 * Real SQLite with foreign keys enabled catches admission and update constraints.
 */
function fixture() {
  const database = openReviewDatabase(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const store = new JobStore(new JobRepository(database), () => Date.parse("2026-11-02T00:00:00Z"));
  return { database, store };
}

describe("JobStore", () => {
  test("deduplicates explicit requests across tool and MCP entry points", () => {
    const { database, store } = fixture();
    try {
      const job = store.submit(submission);
      expect(store.submit({ ...submission, source: "tool" })).toEqual(job);
      expect(store.next()).toHaveLength(1);
      expect(() =>
        store.submit({
          ...submission,
          url: "https://github.com/example/project/pull/43",
          candidate: {
            ...submission.candidate,
            number: 43,
            url: "https://github.com/example/project/pull/43",
          },
        }),
      ).toThrow("different review");
      expect(() => store.submit({ ...submission, delivery: "publish" })).toThrow("delivery policy");
    } finally {
      database.close();
    }
  });

  test("replays submission and retry receipts after reopening the database", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "picco-explicit-receipts-"));
    const filename = path.join(directory, "reviews.sqlite");
    const first = openReviewDatabase(filename);
    const initial = new JobStore(new JobRepository(first));
    const job = initial.submit(submission);
    const run = initial.admit(job.id, "session")!;
    initial.attempts.finish(run.id, { status: "blocked" });
    initial.retry(job.id, {
      candidate: submission.candidate,
      base: submission.base,
      requestId: "retry-1",
    });
    first.close();
    const second = openReviewDatabase(filename);
    const reopened = new JobStore(new JobRepository(second));
    try {
      expect(reopened.lookupRequest(submission.requestId, submission.url)?.id).toBe(job.id);
      expect(reopened.submit({ ...submission, source: "tool" }).id).toBe(job.id);
      expect(
        reopened.retry(job.id, {
          candidate: submission.candidate,
          base: submission.base,
          requestId: "retry-1",
        }).id,
      ).toBe(job.id);
      expect(reopened.next()).toHaveLength(1);
      expect(reopened.find(job.id)?.runs).toHaveLength(1);
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps immutable attempts and full results across retry", () => {
    const { database, store } = fixture();
    try {
      const job = store.submit(submission);
      const first = store.admit(job.id, "session-1")!;
      const capture = { complete: false, value: { report: "x".repeat(15000) } };
      store.attempts.capture(first.id, capture);
      store.attempts.finish(first.id, { status: "blocked", output: "diagnostic" });
      const candidate = { ...submission.candidate, head: "c".repeat(40) };
      store.retry(job.id, { candidate, base: "d".repeat(40), requestId: "retry-1" });
      const second = store.admit(job.id, "session-2")!;
      expect(
        store.retry(job.id, { candidate, base: "d".repeat(40), requestId: "retry-1" }).status,
      ).toBe("running");
      expect(first.id).not.toBe(second.id);
      expect(store.find(job.id)?.runs.map((run) => run.head)).toEqual([
        "a".repeat(40),
        "c".repeat(40),
      ]);
      expect(store.attempts.result(first.id)).toEqual(capture);
      expect(() => store.attempts.capture(first.id, { complete: true, value: {} })).toThrow(
        "already captured",
      );
    } finally {
      database.close();
    }
  });

  test("restarts abandoned executions as new attempts while retaining reports", () => {
    const { database, store } = fixture();
    try {
      const job = store.submit(submission);
      const first = store.admit(job.id, "old-session")!;
      store.attempts.capture(first.id, { complete: true, value: { report: "saved" } });
      expect(() => store.attempts.finish(first.id, { status: "completed" })).toThrow(
        "not been declared",
      );
      store.recoverInterrupted();
      expect(store.find(job.id)?.job.status).toBe("queued");
      expect(store.find(job.id)?.runs[0]).toMatchObject({
        status: "interrupted",
        reason: "runtime-restarted",
      });
      expect(store.attempts.markReviewed(first.id, "late completion")).toBe(false);
      store.refresh(job.id, { ...submission.candidate, head: "c".repeat(40) }, "d".repeat(40));
      const fresh = store.admit(job.id, "fresh-session")!;
      expect(fresh.id).not.toBe(first.id);
      expect(fresh.head).toBe("c".repeat(40));
      expect(fresh.base).toBe("d".repeat(40));
      expect(store.attempts.result(first.id)).toEqual({
        complete: true,
        value: { report: "saved" },
      });
    } finally {
      database.close();
    }
  });

  test("completion remains completed when the host restarts before teardown", () => {
    const { database, store } = fixture();
    try {
      const job = store.submit(submission);
      const run = store.admit(job.id, "session")!;
      expect(store.attempts.markReviewed(run.id, "done")).toBe(true);
      store.recoverInterrupted();
      expect(store.find(job.id)?.job.status).toBe("completed");
      expect(store.find(job.id)?.runs[0]?.status).toBe("completed");
      expect(store.next()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("opens a version 1 database without changing completed cycles or uncertain claims", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "picco-explicit-migration-"));
    const filename = path.join(directory, "reviews.sqlite");
    const original = createReviewStore(filename);
    original.reconcile("reviewer", [submission.candidate]);
    const automatic = original.admit(original.next()[0]!.id, "reviewer", 3)!;
    original.markReviewed(automatic.id, "published review");
    original.finish(automatic.id, { status: "completed" });
    original.reconcile("reviewer", [
      { ...submission.candidate, number: 43, url: "https://github.com/example/project/pull/43" },
    ]);
    const uncertain = original.admit(original.next()[0]!.id, "reviewer", 3)!;
    original.finish(uncertain.id, { status: "interrupted" });
    original.close();
    const database = openReviewDatabase(filename);
    const tables = [
      "schema_migrations",
      "review_queue",
      "review_runs",
      "review_claims",
      "reviewed_commits",
      "poller_state",
    ];
    const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
    database.exec(
      "DROP TABLE explicit_review_requests; DROP TABLE explicit_review_attempts; DROP TABLE explicit_review_jobs; DROP TABLE review_results;",
    );
    database.close();
    const reopened = createReviewStore(filename);
    try {
      const job = reopened.jobs.submit(submission);
      const run = reopened.jobs.admit(job.id, "local")!;
      reopened.jobs.attempts.markReviewed(run.id, "local-only review");
      reopened.jobs.attempts.finish(run.id, { status: "completed" });
      const connection = openReviewDatabase(filename);
      try {
        expect(tables.map((table) => connection.prepare(`SELECT * FROM ${table}`).all())).toEqual(
          before,
        );
      } finally {
        connection.close();
      }
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancelled queued jobs never create an attempt", () => {
    const { database, store } = fixture();
    try {
      const job = store.submit(submission);
      expect(store.cancelQueued(job.id).status).toBe("cancelled");
      expect(store.admit(job.id, "session")).toBeNull();
      expect(store.find(job.id)?.runs).toEqual([]);
    } finally {
      database.close();
    }
  });
});
