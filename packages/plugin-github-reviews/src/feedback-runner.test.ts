import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type ToolContext } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContext } from "@picco-agent/core/testing";
import { runFeedback } from "./feedback-runner.js";
import { createFeedbackStore } from "./feedback-store.js";
import { type FeedbackCandidate } from "./feedback-source.js";
import { type FeedbackRun } from "./feedback-types.js";

/**
 * A batch independent of the scripted worker's completion behaviour.
 */
const candidate: FeedbackCandidate = {
  repository: "example/project",
  number: 42,
  title: "Improve cleanup",
  url: "https://github.com/example/project/pull/42",
  head: "a".repeat(40),
  headRepository: "owner/fork",
  headBranch: "fix-cleanup",
  reviews: [
    {
      id: "review-1",
      author: "reviewer",
      url: "https://github.com/example/project/pull/42#pullrequestreview-1",
      submittedAt: "2026-10-28T00:00:00Z",
      body: "Check cleanup",
      state: "CHANGES_REQUESTED",
      inlineCommentCount: 1,
    },
  ],
};

/**
 * Real feedback persistence with scripted session I/O.
 */
function fixture(
  reply: (ctx: FakePluginContext, run: FeedbackRun) => Promise<string> = async () => "Blocked",
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "feedback-runner-"));
  const store = createFeedbackStore(path.join(directory, "feedback.sqlite"));
  store.reconcile("owner", [candidate]);
  const run = store.admit(candidate, "owner", 0, 0)!;
  const ctx: FakePluginContext = createFakePluginContext({
    source: "github-feedback",
    reply: () => reply(ctx, run),
  });
  return {
    ctx,
    store,
    run,
    directory,
    options: {
      ctx,
      store,
      run,
      skill: "address-pr-feedback",
      feedbackDirectory: directory,
      timeoutMs: 60_000,
      renewDispatcherLease: () => true,
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Invoke the actual completion contract with a chosen bridge caller identity.
 */
async function complete(ctx: FakePluginContext, run: FeedbackRun, caller?: ToolContext["caller"]) {
  const selected = ctx.sessionTools
    .find((entry) => entry.key === run.sessionKey)
    ?.tools.find((entry) => entry.name === "github_feedback_complete");
  if (!selected) throw new Error("No feedback completion tool");
  return selected.execute(
    selected.input.parse({
      summary: "Feedback triaged",
      commentUrl: `${run.url}#issuecomment-100`,
    }),
    {
      caller: caller ?? {
        kind: "session",
        ref: { source: "github-feedback", key: run.sessionKey },
      },
      logger: ctx.logger,
    },
  );
}

describe("runFeedback", () => {
  test("records no-change triage only after an explicit declaration and teardown", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "No worthwhile fixes";
    });
    try {
      const result = await runFeedback({
        ...state.options,
        onRunComplete: (outcome) => {
          expect(state.ctx.sessions.list()).toEqual([]);
          expect(state.store.details(outcome.selection.run.id).state).toBe("completed");
        },
      }).completion;
      expect(result).toMatchObject({
        status: "completed",
        summary: "Feedback triaged",
        commentUrl: `${candidate.url}#issuecomment-100`,
      });
      expect(state.store.next(0, 0)).toEqual([]);
      expect(state.ctx.turns[0].prompt).toContain("owner/fork.git");
      expect(state.ctx.turns[0].prompt).toContain("without force");
    } finally {
      state.cleanup();
    }
  });

  test("plain output leaves feedback blocked and never consumes its reviews", async () => {
    const state = fixture();
    try {
      expect((await runFeedback(state.options).completion).status).toBe("blocked");
      expect(state.store.details(state.run.id)).toMatchObject({ state: "blocked" });
      state.store.reconcile("owner", [{ ...candidate, head: "b".repeat(40) }]);
      expect(state.store.next(0, 0)).toEqual([]);
    } finally {
      state.cleanup();
    }
  });

  test("an abort during setup records interruption without starting a session", async () => {
    const state = fixture();
    try {
      const worker = runFeedback(state.options);
      worker.abort("Dispatcher stopped during setup");
      const result = await worker.completion;
      expect(result).toMatchObject({
        status: "interrupted",
        error: "Dispatcher stopped during setup",
      });
      expect(state.ctx.turns).toEqual([]);
      expect(state.store.details(state.run.id)).toMatchObject({ state: "interrupted" });
      expect(state.store.next(0, 0)).toEqual([]);
    } finally {
      state.cleanup();
    }
  });

  test("rejects another session and a lost dispatcher before recording completion", async () => {
    const state = fixture(async (ctx, run) => {
      await expect(complete(ctx, run, { kind: "host" })).rejects.toThrow(
        "Only this feedback session",
      );
      await expect(
        complete(ctx, run, { kind: "session", ref: { source: "github-feedback", key: "other" } }),
      ).rejects.toThrow("Only this feedback session");
      return "Blocked";
    });
    try {
      expect((await runFeedback(state.options).completion).status).toBe("blocked");
      expect(state.store.details(state.run.id).declaration).toBeUndefined();
    } finally {
      state.cleanup();
    }
    const lost = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    let checks = 0;
    try {
      const result = await runFeedback({
        ...lost.options,
        renewDispatcherLease: () => ++checks === 1,
      }).completion;
      expect(result.status).toBe("interrupted");
      expect(lost.store.details(lost.run.id).declaration).toBeUndefined();
    } finally {
      lost.cleanup();
    }
  });

  test("preserves declared remote evidence when the worker disconnects afterwards", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      throw new Error("Disconnected after publication");
    });
    try {
      expect((await runFeedback(state.options).completion).status).toBe("interrupted");
      expect(state.store.details(state.run.id)).toMatchObject({
        state: "interrupted",
        declaration: { summary: "Feedback triaged" },
      });
      state.store.resolve(
        state.run.id,
        "retry",
        "Worker stopped; inspect saved publication on retry",
      );
      const retry = state.store.admit(candidate, "owner", 0, 0)!;
      const result = await runFeedback({ ...state.options, run: retry }).completion;
      expect(result.selection.artifactDirectory).toBe(
        path.join(state.directory, "runs", state.run.id),
      );
    } finally {
      state.cleanup();
    }
  });

  test("callback failures do not repeat or invalidate completed work", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    try {
      const result = await runFeedback({
        ...state.options,
        onRunStart: () => {
          throw new Error("Start delivery unavailable");
        },
        onRunComplete: () => {
          throw new Error("Outcome delivery unavailable");
        },
      }).completion;
      expect(result.status).toBe("completed");
      expect(state.ctx.turns).toHaveLength(1);
      expect(state.store.next(0, 0)).toEqual([]);
    } finally {
      state.cleanup();
    }
  });

  test("holds the slot through teardown and blocks after teardown failure", async () => {
    const state = fixture(async (ctx, run) => {
      await complete(ctx, run);
      return "Done";
    });
    try {
      const result = await runFeedback({
        ...state.options,
        ctx: {
          ...state.ctx,
          sessions: {
            ...state.ctx.sessions,
            reset: async () => {
              expect(state.store.details(state.run.id).state).toBe("running");
              throw new Error("Could not stop worker");
            },
          },
        },
      }).completion;
      expect(result.status).toBe("interrupted");
      expect(state.store.details(state.run.id).declaration).toBeDefined();
      expect(state.store.status().paused).toBe(true);
    } finally {
      state.cleanup();
    }
  });
});
