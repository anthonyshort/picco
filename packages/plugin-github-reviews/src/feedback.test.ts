import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Plugin } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContext } from "@picco-agent/core/testing";
import { z } from "zod";
import { githubFeedback } from "./feedback.js";
import { type GithubExecute } from "./github-contracts.js";
import { createFeedbackStore } from "./feedback-store.js";
import {
  type FeedbackSelection,
  type GithubFeedbackOptions,
  type GithubFeedbackResult,
} from "./feedback-types.js";

/**
 * Isolate persisted plugin state between tests.
 */
let directory: string;
/**
 * Stop timers and owned stores before deleting test state.
 */
let plugins: Plugin[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "feedback-plugin-"));
  plugins = [];
});
afterEach(async () => {
  for (const plugin of plugins.reverse()) await plugin.stop?.();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

/**
 * Script only the external GraphQL boundary while keeping discovery and persistence real.
 */
function githubFixture() {
  const state = {
    author: "owner",
    head: "a".repeat(40),
    reviews: ["review-1"],
    fail: false,
    remaining: 4000,
    closed: false,
    calls: 0,
    injectReviewAtInspection: false,
    inspections: 0,
  };
  const execute: GithubExecute = async (args, input) => {
    expect(args).toEqual(["api", "graphql", "--input", "-"]);
    state.calls++;
    if (state.fail) throw new Error("Discovery unavailable");
    const request = z.object({ query: z.string() }).parse(JSON.parse(input!));
    const rateLimit = { cost: 1, remaining: state.remaining, resetAt: "2026-10-28T13:00:00Z" };
    const pull = {
      repository: { nameWithOwner: "example/project" },
      number: 42,
      url: "https://github.com/example/project/pull/42",
      title: "A PR",
      state: state.closed ? "CLOSED" : "OPEN",
      author: { login: state.author },
      headRefOid: state.head,
      headRepository: { nameWithOwner: "owner/fork" },
      headRefName: "feature",
      isDraft: true,
    };
    if (request.query.includes("AuthoredFeedback"))
      return JSON.stringify({
        data: {
          viewer: {
            login: state.author,
            pullRequests: {
              nodes: [pull],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        },
      });
    state.inspections++;
    if (state.injectReviewAtInspection && state.inspections === 3)
      state.reviews.push("review-during-inspection");
    return JSON.stringify({
      data: {
        viewer: { login: state.author },
        rateLimit,
        repository: {
          nameWithOwner: "example/project",
          pullRequest: {
            ...pull,
            reviews: {
              nodes: state.reviews.map((id) => ({
                id,
                author: { login: "reviewer" },
                submittedAt: "2026-10-28T11:00:00Z",
                body: "Please fix",
                state: "CHANGES_REQUESTED",
                url: `${pull.url}#${id}`,
                comments: { totalCount: 1 },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  };
  return { state, execute };
}

/**
 * Exercise management tools with their public validation and host identity.
 */
async function invoke(plugin: Plugin, name: string, input = {}) {
  const selected = plugin.tools!.find((entry) => entry.name === name)!;
  return selected.execute(selected.input.parse(input), {
    caller: { kind: "host" },
    logger: createFakePluginContext().logger,
  });
}

/**
 * The fake worker completes through the real session-bound tool.
 */
async function complete(ctx: FakePluginContext, key: string) {
  const tool = ctx.sessionTools
    .find((entry) => entry.key === key)
    ?.tools.find((entry) => entry.name === "github_feedback_complete");
  if (!tool) throw new Error("Missing completion tool");
  await tool.execute(tool.input.parse({ summary: "Feedback addressed" }), {
    caller: { kind: "session", ref: { source: "github-feedback", key } },
    logger: ctx.logger,
  });
}

/**
 * Start a fresh dispatcher with a self-completing scripted worker.
 */
async function start(execute: GithubExecute, overrides: Partial<GithubFeedbackOptions> = {}) {
  const starts: FeedbackSelection[] = [];
  const results: GithubFeedbackResult[] = [];
  const ctx: FakePluginContext = createFakePluginContext({
    source: "github-feedback",
    reply: async ({ key }) => {
      await complete(ctx, key!);
      return "Done";
    },
  });
  const plugin = githubFeedback({
    enabled: true,
    feedbackDirectory: directory,
    github: { execute },
    onRunStart: (selection) => {
      starts.push(selection);
    },
    onRunComplete: (result) => {
      results.push(result);
    },
    ...overrides,
  });
  await plugin.start!(ctx);
  plugins.push(plugin);
  return { plugin, ctx, starts, results };
}

describe("githubFeedback", () => {
  test("closes the store when persisted dispatcher state makes claiming fail", async () => {
    const filename = path.join(directory, "feedback.sqlite");
    createFeedbackStore(filename).close();
    const database = new DatabaseSync(filename);
    database
      .prepare("INSERT INTO feedback_dispatcher VALUES (1,?,?,?,?)")
      .run("other", 0, "host", 0);
    database.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const plugin = githubFeedback({ feedbackDirectory: directory });
      await expect(plugin.start!(createFakePluginContext())).rejects.toMatchObject({
        name: "ZodError",
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  test("preserves the setup error and closes the store if lease cleanup also fails", async () => {
    const filename = path.join(directory, "feedback.sqlite");
    createFeedbackStore(filename).close();
    const database = new DatabaseSync(filename);
    database
      .prepare("INSERT INTO feedback_state VALUES ('poll',?)")
      .run(JSON.stringify({ attemptedAt: "invalid" }));
    database.close();
    const prepare = DatabaseSync.prototype.prepare;
    const failedRelease = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql.startsWith("DELETE FROM feedback_dispatcher"))
        throw new Error("Lease cleanup failed");
      return prepare.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const plugin = githubFeedback({ feedbackDirectory: directory });
      await expect(plugin.start!(createFakePluginContext())).rejects.toMatchObject({
        name: "ZodError",
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      failedRelease.mockRestore();
    }
  });

  test("disabled feedback exposes tools without GitHub or model calls", async () => {
    const github = githubFixture();
    const current = await start(github.execute, { enabled: false });
    await invoke(current.plugin, "github_feedback_poll");
    await invoke(current.plugin, "github_feedback_resume");
    expect(github.state.calls).toBe(0);
    expect(current.ctx.turns).toEqual([]);
    expect(await invoke(current.plugin, "github_feedback_status")).toContain('"enabled":false');
  });

  test("waits ten quiet minutes across restart and never retriggers on a push", async () => {
    const github = githubFixture();
    const first = await start(github.execute);
    await invoke(first.plugin, "github_feedback_poll");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await invoke(first.plugin, "github_feedback_poll");
    expect(first.ctx.turns).toEqual([]);
    await first.plugin.stop!();
    const next = await start(github.execute);
    await vi.advanceTimersByTimeAsync(60_000);
    await invoke(next.plugin, "github_feedback_poll");
    await vi.waitFor(() => expect(next.results).toHaveLength(1));
    expect(next.results[0].status).toBe("completed");
    expect(next.starts).toHaveLength(1);
    github.state.head = "b".repeat(40);
    await invoke(next.plugin, "github_feedback_poll");
    expect(next.ctx.turns).toHaveLength(1);
    github.state.reviews.push("review-2");
    await invoke(next.plugin, "github_feedback_poll");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await invoke(next.plugin, "github_feedback_poll");
    await vi.waitFor(() => expect(next.results).toHaveLength(2));
    expect(next.results[1].selection.run.reviews.map((review) => review.id)).toEqual(["review-2"]);
  });

  test("a review discovered during admission resets the quiet period", async () => {
    const github = githubFixture();
    github.state.injectReviewAtInspection = true;
    const current = await start(github.execute);
    await invoke(current.plugin, "github_feedback_poll");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await invoke(current.plugin, "github_feedback_poll");
    expect(current.ctx.turns).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await invoke(current.plugin, "github_feedback_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    expect(current.results[0].selection.run.reviews).toHaveLength(2);
  });

  test("pause persists while discovery continues and errors retain work", async () => {
    const github = githubFixture();
    const current = await start(github.execute);
    await invoke(current.plugin, "github_feedback_pause");
    await invoke(current.plugin, "github_feedback_poll");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    github.state.fail = true;
    await invoke(current.plugin, "github_feedback_poll");
    expect(await invoke(current.plugin, "github_feedback_status")).toContain(
      "Discovery unavailable",
    );
    expect(current.ctx.turns).toEqual([]);
    expect(await invoke(current.plugin, "github_feedback_list")).toContain("review-1");
  });

  test("manual polls honour persisted API backoff", async () => {
    const github = githubFixture();
    github.state.remaining = 0;
    const first = await start(github.execute);
    await invoke(first.plugin, "github_feedback_poll");
    const calls = github.state.calls;
    await first.plugin.stop!();
    const next = await start(github.execute);
    await invoke(next.plugin, "github_feedback_poll");
    await invoke(next.plugin, "github_feedback_resume");
    expect(github.state.calls).toBe(calls);
    expect(next.ctx.turns).toEqual([]);
  });

  test("rejects a second dispatcher and pauses changed authenticated identity", async () => {
    const github = githubFixture();
    const first = await start(github.execute);
    await invoke(first.plugin, "github_feedback_poll");
    const other = githubFeedback({ feedbackDirectory: directory });
    await expect(other.start!(createFakePluginContext())).rejects.toThrow(
      "Another GitHub feedback dispatcher",
    );
    await invoke(first.plugin, "github_feedback_poll");
    expect(await invoke(first.plugin, "github_feedback_status")).toContain('"ownershipLost":false');
    await first.plugin.stop!();
    github.state.author = "another-owner";
    const next = await start(github.execute);
    await invoke(next.plugin, "github_feedback_poll");
    expect(await invoke(next.plugin, "github_feedback_status")).toContain('"paused":true');
    expect(next.ctx.turns).toEqual([]);
  });
});
