import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type ToolContext } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContext } from "@picco-agent/core/testing";
import { type Candidate } from "./github.js";
import { runReview } from "./runner.js";
import { createReviewStore, type StoreRun } from "./store.js";

/**
 * A selected PR identity independent of review execution.
 */
const candidate: Candidate = {
  repository: "example/project",
  number: 42,
  title: "Improve worker cleanup",
  url: "https://github.com/example/project/pull/42",
  head: "a".repeat(40),
  createdAt: "2026-10-01T00:00:00Z",
};

/**
 * A scripted worker can invoke the actual session-bound completion tool.
 */
type WorkerReply = (ctx: FakePluginContext, run: StoreRun) => Promise<string>;

/**
 * Real persistent reservations with an independently controlled lease clock.
 */
function fixture(reply: WorkerReply = async () => "Review finished") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "picco-review-runner-"));
  let time = Date.parse("2026-10-26T00:00:00Z");
  const store = createReviewStore(path.join(directory, "reviews.sqlite"), () => time);
  store.reconcile("reviewer", [candidate]);
  const item = store.next()[0];
  if (!item) throw new Error("Review fixture did not queue its PR");
  const run = store.admit(item.id, "reviewer", 1);
  if (!run) throw new Error("Review fixture could not reserve its PR");
  const ctx: FakePluginContext = createFakePluginContext({
    source: "github-reviews",
    reply: () => reply(ctx, run),
  });
  return {
    ctx,
    store,
    run,
    directory,
    options: { ctx, store, run, skill: "review", reviewsDirectory: directory, timeoutMs: 60_000 },
    advance(milliseconds: number) {
      time += milliseconds;
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Execute the real scoped tool with the identity attached by the session bridge.
 */
async function complete(ctx: FakePluginContext, run: StoreRun, caller?: ToolContext["caller"]) {
  const selected = ctx.sessionTools.find((binding) => binding.key === run.sessionKey);
  const tool = selected?.tools.find((bound) => bound.name === "github_review_complete");
  if (!tool) throw new Error("Worker did not receive its completion tool");
  return await tool.execute(tool.input.parse({ summary: "Reviewed every changed file" }), {
    logger: ctx.logger,
    caller: caller ?? { kind: "session", ref: { source: "github-reviews", key: run.sessionKey } },
  });
}

/**
 * A controlled boundary for teardown and worker completion races.
 */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("runReview", () => {
  test("awaits start reporting with the reservation held before starting the worker", async () => {
    const state = fixture();
    const started = gate();
    const release = gate();
    const worker = runReview({
      ...state.options,
      onRunStart: async (selection) => {
        expect(selection.run).toEqual(state.run);
        expect(selection.skill).toBe("review");
        expect(state.store.status().reservations).toMatchObject([{ runId: state.run.id }]);
        expect(state.ctx.turns).toEqual([]);
        started.release();
        await release.promise;
      },
    });
    try {
      await started.promise;
      expect(state.ctx.turns).toEqual([]);
      release.release();
      await worker.completion;
      expect(state.ctx.turns).toHaveLength(1);
    } finally {
      release.release();
      await worker.completion;
      state.cleanup();
    }
  });

  test.each(["throw", "timeout"])(
    "start callback %s does not prevent review or retry delivery",
    async (failure) => {
      vi.useFakeTimers();
      const entered = gate();
      const state = fixture(async (ctx, run) => {
        await complete(ctx, run);
        return "Done";
      });
      let attempts = 0;
      const worker = runReview({
        ...state.options,
        onRunStart: () => {
          attempts++;
          entered.release();
          if (failure === "throw") throw new Error("Notification unavailable");
          return new Promise<void>(() => {});
        },
      });
      try {
        await entered.promise;
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(30_000);
        expect((await worker.completion).status).toBe("completed");
        expect(attempts).toBe(1);
        expect(state.ctx.turns).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        state.cleanup();
      }
    },
  );

  test("abort during start reporting prevents worker startup", async () => {
    const state = fixture();
    const entered = gate();
    const release = gate();
    const worker = runReview({
      ...state.options,
      onRunStart: async () => {
        entered.release();
        await release.promise;
      },
    });
    try {
      await entered.promise;
      worker.abort("Host stopping");
      release.release();
      expect(await worker.completion).toMatchObject({
        status: "interrupted",
        error: "Host stopping",
      });
      expect(state.ctx.turns).toEqual([]);
    } finally {
      release.release();
      await worker.completion;
      state.cleanup();
    }
  });

  test("records an explicit reviewed declaration and closes the session before completion", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "All done";
    });
    try {
      const result = await runReview(state.options).completion;
      expect(result).toMatchObject({
        status: "completed",
        summary: "Reviewed every changed file",
        output: "All done",
      });
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        true,
      );
      expect(state.store.status().reservations).toEqual([]);
      expect(state.ctx.sessions.list()).toEqual([]);
      expect(state.ctx.turns[0]?.session).toMatchObject({
        cwd: path.join(state.directory, "runs", state.run.id),
        env: { REVIEW_RUN_ID: state.run.id },
      });
      expect(state.ctx.turns[0]?.prompt).toContain("github_review_complete");
    } finally {
      state.cleanup();
    }
  });

  test("plain final text cannot mark the selected commit as reviewed", async () => {
    const state = fixture();
    try {
      const result = await runReview(state.options).completion;
      expect(result.status).toBe("blocked");
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        false,
      );
      expect(state.store.status().reservations).toMatchObject([
        { runId: state.run.id, uncertain: 1 },
      ]);
      expect(state.store.details(state.run.id)).toMatchObject({
        item: { status: "blocked", reason: "publication-uncertain" },
      });
      expect(state.ctx.sessions.list()).toEqual([]);
    } finally {
      state.cleanup();
    }
  });

  test("rejects completion from another session before recording reviewed history", async () => {
    const state = fixture(async (ctx, run) => {
      await expect(
        complete(ctx, run, {
          kind: "session",
          ref: { source: "github-reviews", key: "another-run" },
        }),
      ).rejects.toThrow("Only this review's session");
      await expect(complete(ctx, run, { kind: "host" })).rejects.toThrow(
        "Only this review's session",
      );
      return "No completion declaration";
    });
    try {
      const result = await runReview(state.options).completion;
      expect(result.status).toBe("blocked");
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        false,
      );
    } finally {
      state.cleanup();
    }
  });

  test("rejects a declaration when the lease expired before the next heartbeat", async () => {
    const state = fixture(async (ctx, run) => {
      state.advance(5 * 60_000 + 1);
      await expect(complete(ctx, run)).rejects.toThrow();
      return "Could not declare completion";
    });
    try {
      const result = await runReview(state.options).completion;
      expect(result.status).toBe("blocked");
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        false,
      );
    } finally {
      state.cleanup();
    }
  });

  test("a worker failure after its declaration preserves reviewed history and uncertainty", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      throw new Error("Worker disconnected after completion");
    });
    try {
      const result = await runReview(state.options).completion;
      expect(result).toMatchObject({
        status: "interrupted",
        error: "Worker disconnected after completion",
      });
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        true,
      );
      expect(state.store.details(state.run.id)).toMatchObject({
        runs: [{ reviewSummary: "Reviewed every changed file" }],
      });
      expect(state.store.status().reservations).toMatchObject([
        { runId: state.run.id, uncertain: 1 },
      ]);
    } finally {
      state.cleanup();
    }
  });

  test("holds the running slot and PR reservation until worker teardown settles", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    const teardownStarted = gate();
    const allowTeardown = gate();
    const ctx = {
      ...state.ctx,
      sessions: {
        ...state.ctx.sessions,
        async reset(key: string) {
          teardownStarted.release();
          await allowTeardown.promise;
          await state.ctx.sessions.reset(key);
        },
      },
    };
    const worker = runReview({ ...state.options, ctx });
    try {
      await teardownStarted.promise;
      expect(state.store.details(state.run.id)?.runs[0]?.status).toBe("running");
      expect(state.store.status().reservations).toMatchObject([
        { runId: state.run.id, uncertain: 0 },
      ]);
      state.store.reconcile("reviewer", [
        candidate,
        { ...candidate, number: 43, url: "https://github.com/example/project/pull/43" },
      ]);
      const waiting = state.store.next()[0];
      expect(waiting?.number).toBe(43);
      expect(state.store.admit(waiting!.id, "reviewer", 1)).toBeNull();
      allowTeardown.release();
      expect((await worker.completion).status).toBe("completed");
      expect(state.store.admit(waiting!.id, "reviewer", 1)).not.toBeNull();
    } finally {
      allowTeardown.release();
      await worker.completion;
      state.cleanup();
    }
  });

  test("callback failure is persisted without rerunning or weakening reviewed completion", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    let attempts = 0;
    try {
      const result = await runReview({
        ...state.options,
        onRunComplete: async () => {
          attempts++;
          throw new Error("Delivery response lost");
        },
      }).completion;
      expect(result.status).toBe("completed");
      expect(attempts).toBe(1);
      expect(state.store.details(state.run.id)).toMatchObject({
        runs: [
          {
            status: "completed",
            notification: "uncertain",
            notificationError: "Completion callback did not confirm delivery",
          },
        ],
      });
      expect(state.store.recordNotificationAttempt(state.run.id)).toBe(false);
      expect(state.store.hasCompleted("reviewer", candidate.repository, 42, candidate.head)).toBe(
        true,
      );
    } finally {
      state.cleanup();
    }
  });

  test("completion callbacks observe durable results after the worker closes", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    try {
      await runReview({
        ...state.options,
        onRunComplete: async (result) => {
          expect(result.status).toBe("completed");
          expect(state.ctx.sessions.list()).toEqual([]);
          expect(state.store.status().reservations).toEqual([]);
          expect(state.store.details(state.run.id)?.runs[0]?.status).toBe("completed");
        },
      }).completion;
      expect(state.store.details(state.run.id)?.runs[0]?.notification).toBe("confirmed");
    } finally {
      state.cleanup();
    }
  });
});
