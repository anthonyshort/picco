import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type FeedbackCandidate } from "./feedback-source.js";
import { createFeedbackStore } from "./feedback-store.js";

/**
 * A submitted review is identified independently of the PR head.
 */
const candidate: FeedbackCandidate = {
  repository: "example/project",
  number: 42,
  title: "Improve queue ordering",
  url: "https://github.com/example/project/pull/42",
  head: "a".repeat(40),
  headRepository: "example/project",
  headBranch: "improve-queue",
  reviews: [
    {
      id: "review:one",
      url: "https://github.com/example/project/pull/42#pullrequestreview-1",
      author: "reviewer",
      submittedAt: "2026-10-27T10:00:00Z",
      body: "Please fix the queue",
      state: "CHANGES_REQUESTED",
      inlineCommentCount: 0,
    },
  ],
};

/**
 * A quiet period and a maximum batch age, in milliseconds.
 */
const DEBOUNCE_MS = 600_000;
/**
 * Continuously arriving reviews must not postpone work beyond thirty minutes.
 */
const MAX_WAIT_MS = 1_800_000;
/**
 * Every test closes all real SQLite connections before removing its directory.
 */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Persist through multiple connections while controlling observed time directly.
 */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "picco-feedback-store-"));
  const filename = path.join(directory, "feedback.sqlite");
  const stores: ReturnType<typeof createFeedbackStore>[] = [];
  let time = Date.parse("2026-10-28T00:00:00Z");
  function open() {
    const store = createFeedbackStore(filename, () => time);
    stores.push(store);
    return store;
  }
  const store = open();
  cleanups.push(() => {
    for (const connection of stores) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    open,
    filename,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

/**
 * Add another independently submitted review to the same PR.
 */
function withReview(id: string, previous = candidate): FeedbackCandidate {
  return { ...previous, reviews: [...previous.reviews, { ...candidate.reviews[0], id }] };
}

describe("createFeedbackStore", () => {
  test("resets the quiet period only for newly observed reviews and preserves it across restart", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    f.advance(540_000);
    f.store.reconcile("author", [candidate]);
    f.advance(60_000);
    expect(f.open().next(DEBOUNCE_MS, MAX_WAIT_MS)).toHaveLength(1);
    const updated = withReview("review:two");
    f.store.reconcile("author", [updated]);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    f.advance(599_999);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    f.advance(1);
    expect(
      f
        .open()
        .next(DEBOUNCE_MS, MAX_WAIT_MS)[0]
        .reviews.map((review) => review.id),
    ).toEqual(["review:one", "review:two"]);
  });

  test("caps continuous batching at thirty minutes from the first observation", () => {
    const f = fixture();
    let current = candidate;
    f.store.reconcile("author", [current]);
    for (const id of ["review:two", "review:three", "review:four"]) {
      f.advance(540_000);
      current = withReview(id, current);
      f.store.reconcile("author", [current]);
      expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    }
    f.advance(179_999);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    f.advance(1);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0].reviews).toHaveLength(4);
  });

  test("completion consumes review IDs rather than the starting head", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    const run = f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    expect(run.reviews).toHaveLength(1);
    expect(() => f.store.finish(run.id, { status: "completed" })).toThrow("requires a declaration");
    expect(
      f.store.declare(run.id, {
        summary: "Fixed",
        pushedHead: "b".repeat(40),
        commentUrl: "https://github.com/example/project/pull/42#issuecomment-1",
      }),
    ).toBe(true);
    f.store.finish(run.id, { status: "completed" });
    const pushed = { ...candidate, head: "b".repeat(40) };
    f.open().reconcile("author", [pushed]);
    f.advance(MAX_WAIT_MS);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    f.store.reconcile("author", [withReview("review:two", pushed)]);
    f.advance(DEBOUNCE_MS);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0].reviews.map((review) => review.id)).toEqual([
      "review:two",
    ]);
  });

  test("freezes the running batch and admits new reviews only after that worker finishes", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    const first = f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    const updated = withReview("review:two");
    f.store.reconcile("author", [updated]);
    f.advance(DEBOUNCE_MS);
    const queued = f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0];
    expect(queued.reviews.map((review) => review.id)).toEqual(["review:two"]);
    expect(f.open().admit(queued, "author", DEBOUNCE_MS, MAX_WAIT_MS)).toBeNull();
    f.store.declare(first.id, { summary: "No changes needed" });
    f.store.finish(first.id, { status: "completed" });
    const second = f.store.admit(queued, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    expect(second.reviews.map((review) => review.id)).toEqual(["review:two"]);
    expect(f.store.details(first.id).run.reviews.map((review) => review.id)).toEqual([
      "review:one",
    ]);
  });

  test("blocks interrupted work across new feedback and preserves artifacts on explicit retry", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    const first = f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    f.store.declare(first.id, {
      summary: "Pushed before teardown failed",
      pushedHead: "b".repeat(40),
    });
    expect(f.open().recoverInterrupted()).toBe(1);
    f.store.reconcile("author", [withReview("review:two")]);
    f.advance(DEBOUNCE_MS);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    expect(f.store.details(first.id)).toMatchObject({
      state: "interrupted",
      declaration: { pushedHead: "b".repeat(40) },
    });
    f.store.resolve(first.id, "retry", "Confirmed worker stopped; resume existing progress");
    const second = f.store.admit(
      f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0],
      "author",
      DEBOUNCE_MS,
      MAX_WAIT_MS,
    )!;
    expect(second.resumeRunId).toBe(first.id);
    expect(second.reviews.map((review) => review.id)).toEqual(["review:one"]);
    expect(() => f.store.resolve(second.id, "retry", "Still running")).toThrow("Only a stopped");
    f.store.finish(second.id, { status: "blocked", error: "Publication failed" });
    f.store.resolve(second.id, "retry", "Retry publication only");
    const third = f.store.admit(
      f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0],
      "author",
      DEBOUNCE_MS,
      MAX_WAIT_MS,
    )!;
    expect(third.resumeRunId).toBe(first.id);
    f.store.declare(third.id, { summary: "Publication repaired" });
    f.store.finish(third.id, { status: "completed" });
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0].reviews.map((review) => review.id)).toEqual([
      "review:two",
    ]);
  });

  test("resolving a failed attempt as completed leaves later feedback pending", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    const first = f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    f.store.finish(first.id, { status: "blocked" });
    f.store.reconcile("author", [withReview("review:two")]);
    f.advance(DEBOUNCE_MS);
    f.store.resolve(first.id, "completed", "Verified pushed changes and summary");
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0].reviews.map((review) => review.id)).toEqual([
      "review:two",
    ]);
    expect(() => f.store.resolve(first.id, "retry", "Duplicate resolution")).toThrow();
  });

  test("withdrawn reviews and closed PRs cannot be admitted", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    f.store.reconcile("author", [{ ...candidate, reviews: [] }]);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    expect(f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)).toBeNull();
    const updated = withReview("review:two");
    f.store.reconcile("author", [updated]);
    f.advance(DEBOUNCE_MS);
    f.store.reconcile("author", []);
    expect(f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)).toEqual([]);
    expect(f.store.admit(updated, "author", DEBOUNCE_MS, MAX_WAIT_MS)).toBeNull();
  });

  test("withdrawn retry feedback cannot attach old progress to a newer review", () => {
    const f = fixture();
    f.store.reconcile("author", [candidate]);
    f.advance(DEBOUNCE_MS);
    const first = f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)!;
    f.store.finish(first.id, { status: "blocked" });
    f.store.resolve(first.id, "retry", "Confirmed stopped");
    const replacement = { ...candidate, reviews: [{ ...candidate.reviews[0], id: "review:two" }] };
    f.store.reconcile("author", [replacement]);
    f.advance(DEBOUNCE_MS);
    const second = f.store.admit(
      f.store.next(DEBOUNCE_MS, MAX_WAIT_MS)[0],
      "author",
      DEBOUNCE_MS,
      MAX_WAIT_MS,
    )!;
    expect(second.resumeRunId).toBeUndefined();
    expect(second.reviews.map((review) => review.id)).toEqual(["review:two"]);
  });

  test("pauses persist and account changes cannot mix histories", () => {
    const f = fixture();
    f.store.reconcile("Author", [candidate]);
    f.store.pause(true);
    f.advance(DEBOUNCE_MS);
    expect(f.open().status()).toMatchObject({ author: "author", paused: true });
    expect(f.store.admit(candidate, "author", DEBOUNCE_MS, MAX_WAIT_MS)).toBeNull();
    f.store.pause(false);
    expect(f.store.bindAuthor("another-author")).toBe(false);
    expect(f.store.status()).toMatchObject({ author: "author", paused: true });
    expect(() => f.store.reconcile("another-author", [])).toThrow("author changed");
    expect(f.store.list()).toHaveLength(1);
  });

  test("dispatcher leases exclude other processes and reject writes after ownership loss", () => {
    const f = fixture();
    const second = f.open();
    expect(f.store.claimDispatcher("one")).toBe(true);
    expect(second.claimDispatcher("two")).toBe(false);
    f.store.reconcile("author", [candidate]);
    f.store.poll({ error: "Rate limited", nextPollAt: "2026-10-28T00:10:00Z" });
    f.advance(240_000);
    expect(f.store.renewDispatcher("one")).toBe(true);
    f.advance(300_000);
    expect(f.store.renewDispatcher("one")).toBe(false);
    expect(second.claimDispatcher("two")).toBe(false);
    expect(() => f.store.pause(false)).toThrow("ownership was lost");
    expect(() => f.store.reconcile("author", [])).toThrow("ownership was lost");
    f.store.releaseDispatcher("one");
    expect(second.claimDispatcher("two")).toBe(true);
    expect(() => f.store.pause(false)).toThrow("ownership was lost");
    f.store.releaseDispatcher("one");
    expect(second.renewDispatcher("two")).toBe(true);
    expect(second.status().poll).toMatchObject({
      error: "Rate limited",
      nextPollAt: "2026-10-28T00:10:00Z",
    });
  });
  test("takes over an expired dispatcher only after its local process has exited", () => {
    const f = fixture();
    expect(f.store.claimDispatcher("one")).toBe(true);
    f.advance(300_000);
    const deadProcess = spawnSync(process.execPath, ["-e", ""]);
    expect(deadProcess.status).toBe(0);
    const database = new DatabaseSync(f.filename);
    database.prepare("UPDATE feedback_dispatcher SET pid=?").run(deadProcess.pid);
    database.close();
    expect(f.open().claimDispatcher("two")).toBe(true);
    expect(() => f.store.pause(false)).toThrow("ownership was lost");
  });
});
