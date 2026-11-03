import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { type Candidate } from "./github.js";
import { createReviewStore } from "./store.js";

/**
 * One personal review request, independently of the storage implementation.
 */
const candidate: Candidate = {
  repository: "example/project",
  number: 42,
  title: "Improve queue ordering",
  url: "https://github.com/example/project/pull/42",
  head: "a".repeat(40),
  createdAt: "2026-10-01T00:00:00Z",
};

/**
 * Independent connections and a controllable clock exercise real SQLite transactions.
 */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "picco-review-store-"));
  const filename = path.join(directory, "reviews.sqlite");
  let time = Date.parse("2026-10-26T00:00:00Z");
  const first = createReviewStore(filename, () => time);
  const second = createReviewStore(filename, () => time);
  return {
    first,
    second,
    filename,
    advance(milliseconds: number) {
      time += milliseconds;
    },
    populate(candidates = [candidate]) {
      first.reconcile("reviewer", candidates);
      return first.next();
    },
    cleanup() {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("createReviewStore", () => {
  test("seeded reviewed commits need no invented queue, run or claim", () => {
    const fixtureState = fixture();
    try {
      const database = new DatabaseSync(fixtureState.filename);
      database
        .prepare(
          "INSERT INTO reviewed_commits(reviewer,repository,number,head,reviewedAt) VALUES (?,?,?,?,?)",
        )
        .run("reviewer", candidate.repository, 42, candidate.head, "2026-10-26T00:00:00Z");
      database.close();
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(true);
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:older",
          "2026-10-25T00:00:00Z",
        ),
      ).toBe(true);
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:newer",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(fixtureState.first.list()).toEqual([]);
      expect(fixtureState.first.status().reservations).toEqual([]);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("legacy completion evidence covers later heads until a strictly newer request", () => {
    const fixtureState = fixture();
    try {
      const database = new DatabaseSync(fixtureState.filename);
      database
        .prepare(
          "INSERT INTO reviewed_commits(reviewer,repository,number,head,reviewedAt) VALUES (?,?,?,?,?)",
        )
        .run("reviewer", candidate.repository, 42, candidate.head, "2026-10-26T00:00:00Z");
      database.close();
      fixtureState.populate([{ ...candidate, head: "b".repeat(40) }]);
      expect(fixtureState.second.hasCompleted("reviewer", candidate.repository, 42)).toBe(true);
      expect(
        fixtureState.second.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:older",
          "2026-10-25T00:00:00Z",
        ),
      ).toBe(true);
      expect(
        fixtureState.second.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:newer",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(fixtureState.second.hasCompleted("other", candidate.repository, 42)).toBe(false);
      expect(fixtureState.second.hasCompleted("reviewer", "example/other", 42)).toBe(false);
      expect(fixtureState.second.hasCompleted("reviewer", candidate.repository, 43)).toBe(false);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("a new request between reviewed declaration and teardown is not an ambiguous prior attempt", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.first.setCycle(item!.id, "request:first", "2026-10-25T00:00:00Z");
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.first.markReviewed(admitted.id, "Reviewed all changed files");
      fixtureState.advance(3000);
      fixtureState.first.finish(admitted.id, { status: "completed" });
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(
        fixtureState.first.hasAttempted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("reviewer binding survives restart and a changed account persists a pause", () => {
    const fixtureState = fixture();
    try {
      expect(fixtureState.first.bindReviewer("Reviewer")).toBe(true);
      expect(fixtureState.second.bindReviewer("reviewer")).toBe(true);
      expect(fixtureState.second.bindReviewer("other")).toBe(false);
      expect(fixtureState.first.status()).toMatchObject({ reviewer: "reviewer", paused: true });
    } finally {
      fixtureState.cleanup();
    }
  });

  test("unsupported schema versions are rejected before creating or modifying workflow tables", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "picco-future-store-"));
    const filename = path.join(directory, "reviews.sqlite");
    const database = new DatabaseSync(filename);
    try {
      database.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (2)",
      );
      expect(() => createReviewStore(filename)).toThrow("Unsupported review database schema");
      expect(database.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 2 },
      ]);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='review_queue'").get(),
      ).toBeUndefined();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("explicit reviewed declarations are canonical without a remote publication", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.first.setCycle(item!.id, "request:first", "2026-10-25T00:00:00Z");
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      expect(fixtureState.first.markReviewed(admitted.id, "Reviewed all changed files")).toBe(true);
      expect(
        fixtureState.second.hasCompleted("reviewer", candidate.repository, 42, "request:first"),
      ).toBe(true);
      fixtureState.first.finish(admitted.id, { status: "completed" });
      expect(fixtureState.first.details(admitted.id)).toMatchObject({
        item: { status: "completed", reason: null },
        runs: [
          { reviewedAt: "2026-10-26T00:00:00.000Z", reviewSummary: "Reviewed all changed files" },
        ],
      });
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(fixtureState.first.hasCompleted("other-reviewer", candidate.repository, 42)).toBe(
        false,
      );
    } finally {
      fixtureState.cleanup();
    }
  });

  test("a complete scan is idempotent, ordered and supersedes absent non-running snapshots", () => {
    const fixtureState = fixture();
    try {
      fixtureState.populate([
        { ...candidate, number: 43, createdAt: "2026-10-02T00:00:00Z" },
        candidate,
      ]);
      fixtureState.populate([
        { ...candidate, number: 43, createdAt: "2026-10-02T00:00:00Z" },
        candidate,
      ]);
      expect(fixtureState.first.next().map((item) => item.number)).toEqual([42, 43]);
      const admitted = fixtureState.first.admit(fixtureState.first.next()[0]!.id, "reviewer", 3)!;
      fixtureState.populate([]);
      expect(fixtureState.first.details(admitted.id)?.item.status).toBe("running");
      expect(
        fixtureState.first.list().find((candidateItem) => candidateItem.number === 43)?.status,
      ).toBe("superseded");
      expect(statSync(fixtureState.filename).mode & 0o777).toBe(0o600);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("claim and run admission are atomic across connections, heads and reviewers", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.first.setCycle(item!.id, "request:first", "2026-10-25T00:00:00Z");
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 3);
      expect(admitted).toMatchObject({
        repository: candidate.repository,
        requestEventId: "request:first",
        head: candidate.head,
      });
      expect(fixtureState.second.admit(item!.id, "reviewer", 3)).toBeNull();
      fixtureState.second.reconcile("other", [{ ...candidate, head: "b".repeat(40) }]);
      const other = fixtureState.second.next().find((queued) => queued.reviewer === "other")!;
      expect(fixtureState.second.admit(other.id, "other", 3)).toBeNull();
      expect(fixtureState.first.status().reservations).toHaveLength(1);
      expect(fixtureState.first.details(admitted!.id)?.runs).toHaveLength(1);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("concurrency and persisted pause are checked inside admission", () => {
    const fixtureState = fixture();
    try {
      const [firstItem, secondItem] = fixtureState.populate([
        candidate,
        { ...candidate, number: 43 },
      ]);
      fixtureState.first.pause(true);
      expect(fixtureState.second.status().paused).toBe(true);
      expect(fixtureState.second.admit(firstItem!.id, "reviewer", 1)).toBeNull();
      fixtureState.first.pause(false);
      expect(fixtureState.first.admit(firstItem!.id, "reviewer", 1)).not.toBeNull();
      expect(fixtureState.second.admit(secondItem!.id, "reviewer", 1)).toBeNull();
    } finally {
      fixtureState.cleanup();
    }
  });

  test("unconfirmed worker completion is rejected and blocked attempts need a newer request", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.first.setCycle(item!.id, "request:first", "2026-10-25T00:00:00Z");
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      expect(() => fixtureState.first.finish(admitted.id, { status: "completed" })).toThrow(
        "without a reviewed declaration",
      );
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.status).toBe("running");
      fixtureState.first.finish(admitted.id, { status: "blocked", reason: "review-not-confirmed" });
      expect(fixtureState.first.details(admitted.id)?.item).toMatchObject({
        status: "blocked",
        reason: "review-not-confirmed",
      });
      expect(
        fixtureState.first.hasAttempted("reviewer", candidate.repository, 42, "request:first"),
      ).toBe(true);
      expect(
        fixtureState.first.hasAttempted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          "2026-10-26T00:00:00Z",
        ),
      ).toBe(true);
      expect(
        fixtureState.first.hasAttempted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(false);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("startup abandons running attempts and preserves declared completions", () => {
    const state = fixture();
    try {
      const item = state.populate()[0]!;
      const run = state.first.admit(item.id, "reviewer", 1)!;
      state.first.recoverInterrupted();
      expect(state.first.details(run.id)?.runs[0]).toMatchObject({
        status: "interrupted",
        reason: "runtime-restarted",
      });
      expect(state.first.status().reservations).toEqual([]);
      expect(state.first.hasAttempted("reviewer", item.repository, item.number)).toBe(false);
      const fresh = state.first.admit(item.id, "reviewer", 1)!;
      expect(fresh.id).not.toBe(run.id);
      expect(state.first.markReviewed(fresh.id, "done")).toBe(true);
      state.first.recoverInterrupted();
      expect(state.first.details(fresh.id)?.runs[0]?.status).toBe("completed");
      expect(state.first.next()).toEqual([]);
    } finally {
      state.cleanup();
    }
  });

  test("notification attempts are durable and an uncertain delivery is never implicitly repeated", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      expect(fixtureState.first.recordNotificationAttempt(admitted.id)).toBe(false);
      fixtureState.first.markReviewed(admitted.id, "Review complete");
      fixtureState.first.finish(admitted.id, { status: "completed" });
      expect(fixtureState.first.recordNotificationAttempt(admitted.id)).toBe(true);
      expect(fixtureState.second.recordNotificationAttempt(admitted.id)).toBe(false);
      fixtureState.first.completeNotification(admitted.id, "uncertain", "Connection closed");
      expect(fixtureState.second.recordNotificationAttempt(admitted.id)).toBe(false);
      expect(fixtureState.first.details(admitted.id)?.runs[0]).toMatchObject({
        notification: "uncertain",
        notificationError: "Connection closed",
      });
    } finally {
      fixtureState.cleanup();
    }
  });

  test("failed polling preserves the last successful poll and its rate snapshot", () => {
    const fixtureState = fixture();
    try {
      fixtureState.first.poll({
        attemptedAt: "2026-10-26T00:00:00Z",
        successfulAt: "2026-10-26T00:00:01Z",
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-10-26T01:00:00Z" },
        error: null,
      });
      fixtureState.first.poll({ attemptedAt: "2026-10-26T00:01:00Z", error: "Read failed" });
      expect(fixtureState.second.status().poll).toMatchObject({
        attemptedAt: "2026-10-26T00:01:00Z",
        successfulAt: "2026-10-26T00:00:01Z",
        error: "Read failed",
        rateLimit: { remaining: 4999 },
      });
    } finally {
      fixtureState.cleanup();
    }
  });
});
