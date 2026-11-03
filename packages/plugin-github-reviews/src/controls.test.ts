import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { createReviewControls } from "./controls.js";
import { createGithubSource } from "./github.js";
import { createReviewStore } from "./store.js";
import { GithubReviewsSettingsSchema } from "./types.js";

/**
 * Real polling claims and receipts with a pure publication verifier.
 */
function fixture(resetError?: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-controls-"));
  const store = createReviewStore(path.join(directory, "reviews.sqlite"));
  const candidate = {
    repository: "owner/project",
    number: 1,
    title: "Change",
    url: "https://github.com/owner/project/pull/1",
    head: "a".repeat(40),
    createdAt: new Date().toISOString(),
  };
  store.reconcile("reviewer", [candidate]);
  const item = store.next()[0]!;
  const run = store.admit(item.id, "reviewer", 1)!;
  store.finish(run.id, { status: "blocked", reason: "publication-uncertain" });
  const ctx = createFakePluginContext({ source: "github-reviews" });
  const poll = vi.fn(async () => {});
  const tools = createReviewControls({
    state: () => ({
      store,
      ctx: {
        ...ctx,
        sessions: {
          ...ctx.sessions,
          async reset(key) {
            if (resetError) throw new Error(resetError);
            await ctx.sessions.reset(key);
          },
        },
      },
    }),
    settings: GithubReviewsSettingsSchema.parse({}),
    source: createGithubSource({
      execute: async () => {
        throw new Error("Unexpected GitHub request");
      },
    }),
    active: new Map(),
    persistenceFailed: () => false,
    signal: () => new AbortController().signal,
    poll,
    dispatch: async () => {},
    redact: (value) => value,
    reviewsDirectory: () => directory,
  });
  async function retry(id: string, requestId: string) {
    const selected = tools.find((value) => value.name === "github_reviews_retry")!;
    return JSON.parse(
      String(
        await selected.execute(selected.input.parse({ id, requestId }), {
          caller: { kind: "mcp" },
          logger: ctx.logger,
        }),
      ),
    );
  }
  return {
    store,
    run,
    candidate,
    poll,
    retry,
    async cancel() {
      const selected = tools.find((value) => value.name === "github_reviews_cancel")!;
      return selected.execute({ id: run.id }, { caller: { kind: "mcp" }, logger: ctx.logger });
    },
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("replays a durable polling retry receipt without repeating verification or polling", async () => {
  const state = fixture();
  try {
    await state.retry(state.run.id, "retry-one");
    const replay = await state.retry(state.run.id, "retry-one");
    expect(replay.runs[0].resolution).toBe("retry");
    expect(state.poll).toHaveBeenCalledTimes(1);
  } finally {
    state.cleanup();
  }
});

test("does not accept another explicit job's receipt for the same pull request", async () => {
  const state = fixture();
  try {
    const first = state.store.jobs.submit({
      candidate: state.candidate,
      url: state.candidate.url,
      requestId: "first",
      base: "b".repeat(40),
      source: "mcp",
      delivery: "local-only",
      reviewer: "reviewer",
      skill: "review",
    });
    const second = state.store.jobs.submit({
      candidate: state.candidate,
      url: state.candidate.url,
      requestId: "second",
      base: "b".repeat(40),
      source: "tool",
      delivery: "local-only",
      reviewer: "reviewer",
      skill: "review",
    });
    state.store.jobs.cancelQueued(second.id);
    await expect(state.retry(second.id, "first")).rejects.toThrow("different review job");
    expect(state.store.jobs.find(first.id)?.job.status).toBe("queued");
    expect(state.store.jobs.find(second.id)?.job.status).toBe("cancelled");
  } finally {
    state.cleanup();
  }
});

test("cancel reports a failed worker reset", async () => {
  const state = fixture("Worker kill failed");
  try {
    await expect(state.cancel()).rejects.toThrow("Worker kill failed");
  } finally {
    state.cleanup();
  }
});
