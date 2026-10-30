import { mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

  test("recorded reviewed truth cannot be erased by an operator retry resolution", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.first.markReviewed(admitted.id, "Complete");
      fixtureState.first.finish(admitted.id, { status: "interrupted" });
      expect(() =>
        fixtureState.first.resolveInterrupted(admitted.id, "retry", "Try again"),
      ).toThrow("already recorded");
      expect(fixtureState.first.status().reservations).toHaveLength(1);
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(true);
      fixtureState.first.resolveInterrupted(admitted.id, "completed", "Verified completed review");
      expect(fixtureState.first.status().reservations).toEqual([]);
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

  test("reviewed declarations survive a crash while its unfinished worker reservation remains uncertain", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.first.markReviewed(admitted.id, "Complete");
      fixtureState.first.recoverInterrupted();
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.status).toBe("interrupted");
      expect(fixtureState.first.status().reservations).toMatchObject([
        { runId: admitted.id, uncertain: 1 },
      ]);
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(true);
      fixtureState.first.resolveInterrupted(
        admitted.id,
        "completed",
        "Confirmed the previous worker ended",
      );
      expect(fixtureState.first.status().reservations).toEqual([]);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("reviewed declarations require a live matching lease", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.advance(5 * 60_000 + 1);
      expect(fixtureState.first.markReviewed(admitted.id, "Complete")).toBe(false);
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(false);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("operator retry resolution releases only an uncertain reservation and preserves its reason", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      expect(() =>
        fixtureState.first.resolveInterrupted(admitted.id, "retry", "Verified no work completed"),
      ).toThrow("no uncertain reservation");
      fixtureState.first.recoverInterrupted();
      fixtureState.first.resolveInterrupted(admitted.id, "retry", "Verified no work completed");
      expect(fixtureState.first.status().reservations).toEqual([]);
      expect(fixtureState.first.hasAttempted("reviewer", candidate.repository, 42)).toBe(false);
      expect(fixtureState.first.details(admitted.id)?.runs[0]).toMatchObject({
        resolution: "retry",
        resolutionReason: "Verified no work completed",
      });
      const [newHead] = fixtureState.populate([{ ...candidate, head: "b".repeat(40) }]);
      expect(fixtureState.second.admit(newHead!.id, "reviewer", 1)).toMatchObject({
        head: "b".repeat(40),
      });
    } finally {
      fixtureState.cleanup();
    }
  });

  test("operator completed resolution establishes reviewed history without GitHub evidence", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.first.recoverInterrupted();
      fixtureState.first.resolveInterrupted(
        admitted.id,
        "completed",
        "Verified saved review report",
        admitted.startedAt,
      );
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(true);
      expect(fixtureState.first.status().reservations).toEqual([]);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("completion recovery preserves a newer request made before operator resolution", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.first.setCycle(item!.id, "request:first", "2026-10-25T00:00:00Z");
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      const reviewedAt = "2026-10-26T00:00:10.000Z";
      const newerRequestAt = "2026-10-26T00:00:20.000Z";
      fixtureState.advance(30_000);
      fixtureState.first.recoverInterrupted();
      fixtureState.first.resolveInterrupted(
        admitted.id,
        "completed",
        "Verified original completion timestamp in saved report",
        reviewedAt,
      );
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          newerRequestAt,
        ),
      ).toBe(false);
      expect(
        fixtureState.first.hasAttempted(
          "reviewer",
          candidate.repository,
          42,
          "request:second",
          newerRequestAt,
        ),
      ).toBe(false);
      expect(
        fixtureState.first.hasCompleted("reviewer", candidate.repository, 42, "request:first"),
      ).toBe(true);
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:equal",
          reviewedAt,
        ),
      ).toBe(true);
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.reviewedAt).toBe(reviewedAt);
      expect(fixtureState.first.status().reservations).toEqual([]);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("completion recovery accepts GitHub evidence from the run's start second", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      fixtureState.advance(500);
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.advance(30_000);
      fixtureState.first.recoverInterrupted();
      const before = fixtureState.first.details(admitted.id);
      const reservations = fixtureState.first.status().reservations;
      expect(() =>
        fixtureState.first.resolveInterrupted(
          admitted.id,
          "completed",
          "Evidence predates this run",
          "2026-10-25T23:59:59Z",
        ),
      ).toThrow();
      expect(fixtureState.first.details(admitted.id)).toEqual(before);
      expect(fixtureState.first.status().reservations).toEqual(reservations);
      fixtureState.first.resolveInterrupted(
        admitted.id,
        "completed",
        "Verified GitHub second-precision completion timestamp",
        "2026-10-26T00:00:00Z",
      );
      expect(admitted.startedAt).toBe("2026-10-26T00:00:00.500Z");
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.reviewedAt).toBe(
        "2026-10-26T00:00:00Z",
      );
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:newer",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(
        fixtureState.first.hasAttempted(
          "reviewer",
          candidate.repository,
          42,
          "request:newer",
          "2026-10-26T00:00:01Z",
        ),
      ).toBe(false);
      expect(fixtureState.first.status().reservations).toEqual([]);
    } finally {
      fixtureState.cleanup();
    }
  });

  test.each([
    { label: "missing", reviewedAt: undefined },
    { label: "malformed", reviewedAt: "not-a-timestamp" },
    { label: "future", reviewedAt: "2026-10-26T00:00:31.000Z" },
    { label: "before the run", reviewedAt: "2026-10-25T23:59:59.000Z" },
  ])("completed resolution rejects $label evidence without changing state", ({ reviewedAt }) => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.advance(30_000);
      fixtureState.first.recoverInterrupted();
      const before = fixtureState.first.details(admitted.id);
      const reservations = fixtureState.first.status().reservations;
      expect(() =>
        fixtureState.first.resolveInterrupted(
          admitted.id,
          "completed",
          "Operator supplied evidence",
          reviewedAt,
        ),
      ).toThrow();
      expect(fixtureState.first.details(admitted.id)).toEqual(before);
      expect(fixtureState.first.status().reservations).toEqual(reservations);
      expect(fixtureState.first.hasCompleted("reviewer", candidate.repository, 42)).toBe(false);
    } finally {
      fixtureState.cleanup();
    }
  });

  test("completed resolution preserves an existing declaration instead of later evidence", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.first.markReviewed(admitted.id, "Original completed review");
      fixtureState.advance(30_000);
      fixtureState.first.recoverInterrupted();
      fixtureState.first.resolveInterrupted(
        admitted.id,
        "completed",
        "Confirmed original declaration",
        "2026-10-26T00:00:30.000Z",
      );
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.reviewedAt).toBe(admitted.startedAt);
      expect(
        fixtureState.first.hasCompleted(
          "reviewer",
          candidate.repository,
          42,
          "request:newer",
          "2026-10-26T00:00:10.000Z",
        ),
      ).toBe(false);
      expect(fixtureState.first.status().reservations).toEqual([]);
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

  test("expired lease renewal returns false and never recycles a possibly publishing reservation", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      fixtureState.advance(60_000);
      expect(fixtureState.first.renew(admitted.id)).toBe(true);
      fixtureState.advance(5 * 60_000 + 1);
      expect(fixtureState.first.renew(admitted.id)).toBe(false);
      expect(fixtureState.second.admit(item!.id, "reviewer", 1)).toBeNull();
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

  test("startup recovery retains uncertain reservations and does not revive them on reconciliation", () => {
    const fixtureState = fixture();
    try {
      const [item] = fixtureState.populate();
      const admitted = fixtureState.first.admit(item!.id, "reviewer", 1)!;
      expect(fixtureState.second.recoverInterrupted()).toBe(1);
      expect(fixtureState.second.recoverInterrupted()).toBe(0);
      fixtureState.advance(86_400_000);
      fixtureState.populate();
      expect(fixtureState.first.next()).toEqual([]);
      expect(fixtureState.first.status().reservations[0]?.uncertain).toBe(1);
      expect(fixtureState.first.details(admitted.id)?.runs[0]?.status).toBe("interrupted");
    } finally {
      fixtureState.cleanup();
    }
  });

  test.each([0, 5 * 60_000 + 1])(
    "reclaims a dead local dispatcher after %i ms without allowing the previous owner back in",
    (elapsed) => {
      const fixtureState = fixture();
      try {
        expect(fixtureState.first.claimDispatcher("first")).toBe(true);
        expect(fixtureState.second.claimDispatcher("second")).toBe(false);
        fixtureState.advance(elapsed);
        expect(fixtureState.second.claimDispatcher("second")).toBe(false);
        const stopped = spawnSync(process.execPath, ["-e", ""]);
        expect(stopped.status).toBe(0);
        const database = new DatabaseSync(fixtureState.filename);
        database.prepare("UPDATE poller_state SET data=? WHERE key='dispatcher'").run(
          JSON.stringify({
            owner: "first",
            expiresAt: Date.parse("2026-10-26T00:05:00Z"),
            host: os.hostname(),
            pid: stopped.pid,
          }),
        );
        database.close();
        expect(fixtureState.second.claimDispatcher("second")).toBe(true);
        expect(fixtureState.first.renewDispatcher("first")).toBe(false);
        fixtureState.first.releaseDispatcher("first");
        expect(fixtureState.first.claimDispatcher("first")).toBe(false);
        fixtureState.second.releaseDispatcher("second");
        expect(fixtureState.first.claimDispatcher("first")).toBe(true);
      } finally {
        fixtureState.cleanup();
      }
    },
  );

  test.each([0, Date.parse("2026-10-26T00:05:00Z")])(
    "dispatcher leases with unknown host or process identity stay blocked (expiry %i)",
    (expiresAt) => {
      const fixtureState = fixture();
      try {
        fixtureState.first.claimDispatcher("first");
        const database = new DatabaseSync(fixtureState.filename);
        for (const identity of [
          { host: "another-host", pid: process.pid },
          { host: os.hostname() },
        ]) {
          database
            .prepare("UPDATE poller_state SET data=? WHERE key='dispatcher'")
            .run(JSON.stringify({ owner: "first", expiresAt, ...identity }));
          expect(fixtureState.second.claimDispatcher("second")).toBe(false);
        }
        database.close();
      } finally {
        fixtureState.cleanup();
      }
    },
  );

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
