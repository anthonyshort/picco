import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFakePluginContext,
  FakeRuntime,
  type FakePluginContext,
} from "@picco-agent/core/testing";
import {
  createAgent,
  silentLogger,
  type Plugin,
  type PrepareExecutionContext,
  type ToolContext,
} from "@picco-agent/core";
import { z } from "zod";
import { githubReviews, GithubReviewsSettingsSchema } from "./index.js";
import { createReviewStore } from "./store.js";
import { type GithubExecute } from "./github.js";
import {
  type GithubReviewResult,
  type GithubReviewsOptions,
  type ReviewSelection,
} from "./types.js";

const Repository = "owner/project";
const Head = "a".repeat(40);
const ToolContext: ToolContext = { caller: { kind: "host" }, logger: silentLogger() };
const GraphqlInputSchema = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});
let directory: string;
let plugins: Plugin[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "github-reviews-plugin-"));
  plugins = [];
});

afterEach(async () => {
  for (const plugin of plugins.reverse()) await plugin.stop?.();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

/**
 * All GitHub reads pass through the public GraphQL transport boundary.
 */
function createGithubFixture() {
  const state = {
    reviewer: "reviewer",
    numbers: [42],
    head: Head,
    request: "request:first",
    requestedAt: "2026-10-25T12:00:00Z",
    ready: true,
    timeline: true,
    remaining: 4000,
    fail: false,
    empty: false,
  };
  const calls: string[] = [];
  const execute: GithubExecute = async (args, input) => {
    expect(args).toEqual(["api", "graphql", "--input", "-"]);
    const request = GraphqlInputSchema.parse(JSON.parse(input!));
    calls.push(request.query);
    if (state.fail) throw new Error("GitHub unavailable");
    const rateLimit = { cost: 1, remaining: state.remaining, resetAt: "2026-10-26T13:00:00Z" };
    const number = typeof request.variables.number === "number" ? request.variables.number : 42;
    const pull = {
      number,
      title: "Requested change",
      url: `https://github.com/${Repository}/pull/${number}`,
      headRefOid: state.head,
      createdAt: "2026-10-25T10:00:00Z",
      isDraft: false,
      state: "OPEN",
      repository: { nameWithOwner: Repository },
    };
    if (request.query.includes("RequestedReviews")) {
      return JSON.stringify({
        data: {
          viewer: { login: state.reviewer },
          repository0: { nameWithOwner: Repository, pullRequests: { totalCount: 1 } },
          search: {
            issueCount: state.empty ? 0 : state.numbers.length,
            nodes: state.empty
              ? []
              : state.numbers.map((candidateNumber) => ({
                  ...pull,
                  number: candidateNumber,
                  url: `https://github.com/${Repository}/pull/${candidateNumber}`,
                })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          rateLimit,
        },
      });
    }
    expect(request.query).toContain("InspectReview");
    return JSON.stringify({
      data: {
        viewer: { login: state.reviewer },
        repository: {
          nameWithOwner: Repository,
          pullRequest: {
            ...pull,
            reviewRequests: {
              nodes: state.ready ? [{ requestedReviewer: { login: state.reviewer } }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            timelineItems: {
              nodes: state.timeline
                ? [
                    {
                      id: state.request,
                      createdAt: state.requestedAt,
                      requestedReviewer: { login: state.reviewer },
                    },
                  ]
                : [],
              pageInfo: { hasPreviousPage: false, startCursor: null },
            },
          },
        },
        rateLimit,
      },
    });
  };
  return { state, calls, execute };
}

/**
 * Drive the session-only completion tool as the owning review worker.
 */
async function complete(ctx: FakePluginContext, key: string) {
  const completion = ctx.sessionTools
    .find((entry) => entry.key === key)
    ?.tools.find((entry) => entry.name === "github_review_complete");
  if (!completion) throw new Error("Completion tool was not bound to the worker");
  await completion.execute(completion.input.parse({ summary: "Review finished" }), {
    caller: { kind: "session", ref: { source: "github-reviews", key } },
    logger: silentLogger(),
  });
}

/**
 * Start a plugin with host-side completion reporting and a self-completing fake worker.
 */
async function start(execute: GithubExecute, overrides: Partial<GithubReviewsOptions> = {}) {
  const results: GithubReviewResult[] = [];
  const starts: ReviewSelection[] = [];
  const ctx = createFakePluginContext({
    source: "github-reviews",
    reply: async ({ key }) => {
      await complete(ctx, key!);
      return "Finished";
    },
  });
  const plugin = githubReviews({
    enabled: true,
    repositories: [{ name: Repository, skill: "review" }],
    reviewsDirectory: directory,
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
  return { plugin, ctx, results, starts };
}

/**
 * Invoke a public management tool using its canonical input parser.
 */
async function invoke(plugin: Plugin, name: string, input = {}) {
  const selected = plugin.tools!.find((entry) => entry.name === name)!;
  return selected.execute(selected.input.parse(input), ToolContext);
}

describe("GitHub reviews plugin", () => {
  test.each([
    { label: "default", options: {} },
    { label: "disabled", options: { holdWorkflows: false } },
  ])("$label workflow holding leaves plain reviews unchanged", ({ options }) => {
    expect(githubReviews(options).prepareExecution).toBeUndefined();
    expect(GithubReviewsSettingsSchema.parse(options).holdWorkflows).toBe(false);
  });

  test("enabled workflow holding waits until the parent handles completion", () => {
    const plugin = githubReviews({ holdWorkflows: true });
    expect(plugin.prepareExecution).toBeTypeOf("function");
    expect(GithubReviewsSettingsSchema.parse({ holdWorkflows: true }).holdWorkflows).toBe(true);
    const completeHold = vi.fn<() => void>();
    const fail = vi.fn<(error: Error) => void>();
    const hold = vi.fn(() => ({ complete: completeHold, fail }));
    const ctx: PrepareExecutionContext = {
      execution: { id: "review-one", session: { source: "github-reviews", key: "review" } },
      signal: new AbortController().signal,
      hold,
    };
    const observer = plugin.prepareExecution!(ctx);
    if (!observer) {
      throw new Error("Expected a review execution observer");
    }
    observer.onEvent({ type: "agent_start" });
    observer.onEvent({ type: "agent_settled" });
    expect(hold).not.toHaveBeenCalled();
    observer.onEvent({
      type: "tool_start",
      tool: "SubagentWorkflow",
      toolCallId: "launch",
      args: {},
    });
    observer.onEvent({
      type: "tool_end",
      tool: "SubagentWorkflow",
      toolCallId: "launch",
      isError: false,
      result: { details: { taskId: "review-workflow" } },
    });
    expect(hold).toHaveBeenCalledWith({ name: "workflow:review-workflow", retireWorker: true });
    observer.onEvent({
      type: "custom_message",
      customType: "subagent-notification",
      details: { id: "review-workflow", status: "completed" },
    });
    expect(completeHold).not.toHaveBeenCalled();
    observer.onEvent({ type: "agent_settled" });
    expect(completeHold).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
    expect(
      plugin.prepareExecution!({
        ...ctx,
        execution: { id: "feedback-one", session: { source: "github-feedback", key: "review" } },
      }),
    ).toBeUndefined();
  });

  test.each([
    { label: "omitted", repositories: undefined },
    { label: "empty", repositories: [] },
  ])(
    "disabled $label repositories keep management tools without GitHub calls",
    async ({ repositories }) => {
      const fixture = createGithubFixture();
      const plugin = githubReviews({
        repositories,
        reviewsDirectory: directory,
        github: { execute: fixture.execute },
      });
      const ctx = createFakePluginContext();
      await plugin.start!(ctx);
      plugins.push(plugin);

      const status = JSON.parse(String(await invoke(plugin, "github_reviews_status")));
      expect(status).toMatchObject({ enabled: false, settings: { repositories: [] } });
      expect(status.settings).toEqual(
        GithubReviewsSettingsSchema.parse({ repositories, reviewsDirectory: directory }),
      );
      expect(JSON.parse(String(await invoke(plugin, "github_reviews_list")))).toEqual([]);
      await invoke(plugin, "github_reviews_poll");
      await invoke(plugin, "github_reviews_resume");
      expect(fixture.calls).toHaveLength(0);
      expect(ctx.turns).toHaveLength(0);
    },
  );

  test.each([
    { label: "omitted", repositories: undefined },
    { label: "empty", repositories: [] },
  ])("enabled $label repositories are rejected", ({ repositories }) => {
    expect(() => githubReviews({ enabled: true, repositories })).toThrow(
      "Configure at least one repository",
    );
  });

  test("disabled configuration and empty polling never start a model", async () => {
    const fixture = createGithubFixture();
    const disabled = await start(fixture.execute, { enabled: false });
    await invoke(disabled.plugin, "github_reviews_poll");
    expect(fixture.calls).toHaveLength(0);
    expect(disabled.ctx.turns).toHaveLength(0);
    await disabled.plugin.stop!();
    fixture.state.empty = true;
    const enabled = await start(fixture.execute);
    await invoke(enabled.plugin, "github_reviews_poll");
    expect(fixture.calls).toHaveLength(1);
    expect(enabled.ctx.turns).toHaveLength(0);
    expect(enabled.results).toHaveLength(0);
  });

  test("the same plugin can reacquire ownership after its dispatcher lease expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = createGithubFixture();
    fixture.state.empty = true;
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    vi.setSystemTime(new Date("2026-10-26T12:06:00.000Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await invoke(current.plugin, "github_reviews_status")).toContain('"ownershipLost":true');
    await invoke(current.plugin, "github_reviews_poll");
    expect(fixture.calls).toHaveLength(1);

    await current.plugin.stop!();
    await current.plugin.start!(current.ctx);
    expect(await invoke(current.plugin, "github_reviews_status")).toContain(
      '"ownershipLost":false',
    );
    await invoke(current.plugin, "github_reviews_poll");
    expect(fixture.calls).toHaveLength(2);
    expect(current.ctx.turns).toHaveLength(0);
  });

  test("resolving historical completion preserves a later same-commit request", async () => {
    const store = createReviewStore(path.join(directory, "reviews.sqlite"));
    store.reconcile("reviewer", [
      {
        repository: Repository,
        number: 42,
        title: "Requested change",
        url: `https://github.com/${Repository}/pull/42`,
        head: Head,
        createdAt: "2026-10-25T10:00:00Z",
      },
    ]);
    const item = store.next()[0];
    store.setCycle(item.id, "request:first", "2026-10-25T12:00:00Z");
    const run = store.admit(item.id, "reviewer", 1)!;
    store.finish(run.id, { status: "interrupted", reason: "publication-uncertain" });
    store.close();
    vi.setSystemTime(new Date("2026-10-26T12:10:00.000Z"));
    const fixture = createGithubFixture();
    fixture.state.request = "request:second";
    fixture.state.requestedAt = "2026-10-26T12:05:00Z";
    const current = await start(fixture.execute);
    const resolution = {
      runId: run.id,
      action: "completed",
      reason: "Verified original published review",
    };
    await expect(invoke(current.plugin, "github_reviews_resolve", resolution)).rejects.toThrow();
    expect(await invoke(current.plugin, "github_reviews_details", { id: run.id })).toContain(
      '"reviewedAt":null',
    );
    await invoke(current.plugin, "github_reviews_resolve", {
      ...resolution,
      reviewedAt: "2026-10-26T12:01:00.000Z",
    });
    expect(await invoke(current.plugin, "github_reviews_details", { id: run.id })).toContain(
      '"reviewedAt":"2026-10-26T12:01:00.000Z"',
    );
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    expect(current.results[0].selection.run.requestEventId).toBe("request:second");
  });

  test("records reviewed commits once across polls and process restarts using only GraphQL", async () => {
    const fixture = createGithubFixture();
    const first = await start(fixture.execute);
    await invoke(first.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(first.results).toHaveLength(1));
    await invoke(first.plugin, "github_reviews_poll");
    expect(first.ctx.turns).toHaveLength(1);
    expect(first.starts).toEqual([first.results[0].selection]);
    expect(first.results[0].status).toBe("completed");
    expect(first.ctx.sessions.list()).toHaveLength(0);
    await first.plugin.stop!();
    const restarted = await start(fixture.execute);
    await invoke(restarted.plugin, "github_reviews_poll");
    expect(restarted.ctx.turns).toHaveLength(0);
    expect(restarted.starts).toEqual([]);
    const reviewed = await invoke(restarted.plugin, "github_reviews_list");
    expect(reviewed).toContain("already-reviewed");
    expect(reviewed).toContain('"status":"completed"');
  });

  test("new commits do not repeat a completed request across polls and restarts", async () => {
    const fixture = createGithubFixture();
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    fixture.state.head = "b".repeat(40);
    await invoke(current.plugin, "github_reviews_poll");
    await invoke(current.plugin, "github_reviews_poll");
    expect(current.ctx.turns).toHaveLength(1);
    await current.plugin.stop!();
    const restarted = await start(fixture.execute);
    await invoke(restarted.plugin, "github_reviews_poll");
    expect(restarted.ctx.turns).toHaveLength(0);
    expect(await invoke(restarted.plugin, "github_reviews_list")).toContain("already-reviewed");

    vi.setSystemTime(new Date("2026-10-26T12:01:00Z"));
    fixture.state.request = "request:second";
    fixture.state.requestedAt = "2026-10-26T12:00:30Z";
    await invoke(restarted.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(restarted.results).toHaveLength(1));
    expect(restarted.results[0].selection.run).toMatchObject({
      head: fixture.state.head,
      requestEventId: "request:second",
    });
  });

  test("missing timeline evidence does not repeat a completed request at a new head", async () => {
    const fixture = createGithubFixture();
    fixture.state.timeline = false;
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    fixture.state.head = "b".repeat(40);
    await invoke(current.plugin, "github_reviews_poll");
    expect(await invoke(current.plugin, "github_reviews_list")).toContain("already-reviewed");
    expect(current.ctx.turns).toHaveLength(1);
  });

  test("a new head does not bypass an earlier unresolved attempt for the same request", async () => {
    const store = createReviewStore(path.join(directory, "reviews.sqlite"));
    store.reconcile("reviewer", [
      {
        repository: Repository,
        number: 42,
        title: "Requested change",
        url: `https://github.com/${Repository}/pull/42`,
        head: Head,
        createdAt: "2026-10-25T10:00:00Z",
      },
    ]);
    const item = store.next()[0];
    store.setCycle(item.id, "request:first", "2026-10-25T12:00:00Z");
    const run = store.admit(item.id, "reviewer", 1)!;
    store.finish(run.id, { status: "blocked", reason: "review-not-confirmed" });
    store.close();
    const fixture = createGithubFixture();
    fixture.state.head = "b".repeat(40);
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    expect(current.ctx.turns).toHaveLength(0);
    expect(await invoke(current.plugin, "github_reviews_list")).toContain(
      "prior-attempt-needs-reconciliation",
    );

    vi.setSystemTime(new Date("2026-10-26T12:01:00Z"));
    fixture.state.request = "request:second";
    fixture.state.requestedAt = "2026-10-26T12:00:30Z";
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    expect(current.results[0].selection.run.head).toBe(fixture.state.head);
  });

  test("a strictly newer personal request permits another review of the same commit", async () => {
    const fixture = createGithubFixture();
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(1));
    vi.setSystemTime(new Date("2026-10-26T12:01:00Z"));
    fixture.state.request = "request:second";
    fixture.state.requestedAt = "2026-10-26T12:00:30Z";
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.results).toHaveLength(2));
    expect(current.results[1].selection.run.requestEventId).toBe("request:second");
  });

  test("pause persists across restart, still allows discovery and blocks admissions", async () => {
    const fixture = createGithubFixture();
    const first = await start(fixture.execute);
    await invoke(first.plugin, "github_reviews_pause");
    await invoke(first.plugin, "github_reviews_poll");
    expect(first.ctx.turns).toHaveLength(0);
    expect(fixture.calls).toHaveLength(1);
    await first.plugin.stop!();
    const restarted = await start(fixture.execute);
    await invoke(restarted.plugin, "github_reviews_poll");
    expect(restarted.ctx.turns).toHaveLength(0);
    await invoke(restarted.plugin, "github_reviews_resume");
    await vi.waitFor(() => expect(restarted.results).toHaveLength(1));
  });

  test("manual polls cannot bypass exhausted GraphQL budget or persisted backoff", async () => {
    const fixture = createGithubFixture();
    fixture.state.remaining = 0;
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_poll");
    await invoke(current.plugin, "github_reviews_poll");
    await invoke(current.plugin, "github_reviews_resume");
    expect(fixture.calls).toHaveLength(1);
    expect(current.ctx.turns).toHaveLength(0);
    expect(await invoke(current.plugin, "github_reviews_status")).toContain(
      "2026-10-26T13:00:00.000Z",
    );
    await current.plugin.stop!();
    const restarted = await start(fixture.execute);
    await invoke(restarted.plugin, "github_reviews_poll");
    expect(fixture.calls).toHaveLength(1);
  });

  test("failed discovery preserves queued observations and blocks new model work", async () => {
    const fixture = createGithubFixture();
    const current = await start(fixture.execute);
    await invoke(current.plugin, "github_reviews_pause");
    await invoke(current.plugin, "github_reviews_poll");
    fixture.state.fail = true;
    await invoke(current.plugin, "github_reviews_poll");
    expect(await invoke(current.plugin, "github_reviews_list")).toContain("Requested change");
    expect(await invoke(current.plugin, "github_reviews_status")).toContain("GitHub unavailable");
    expect(current.ctx.turns).toHaveLength(0);
  });

  test("another server cannot dispatch against the same review database", async () => {
    const fixture = createGithubFixture();
    await start(fixture.execute);
    const duplicate = githubReviews({
      repositories: [{ name: Repository, skill: "review" }],
      reviewsDirectory: directory,
    });
    await expect(duplicate.start!(createFakePluginContext())).rejects.toThrow(
      "Another GitHub review dispatcher",
    );
  });
  test("reviewer changes across restarts pause admissions without mixing account histories", async () => {
    const fixture = createGithubFixture();
    const first = await start(fixture.execute);
    await invoke(first.plugin, "github_reviews_pause");
    await invoke(first.plugin, "github_reviews_poll");
    await first.plugin.stop!();
    fixture.state.reviewer = "another-reviewer";
    const restarted = await start(fixture.execute);
    await invoke(restarted.plugin, "github_reviews_resume");
    expect(restarted.ctx.turns).toHaveLength(0);
    const status = await invoke(restarted.plugin, "github_reviews_status");
    expect(status).toContain('"paused":true');
    expect(status).toContain("reviewer changed");
  });

  test("a freed worker slot immediately admits the next oldest queued PR", async () => {
    const fixture = createGithubFixture();
    fixture.state.numbers = [43, 42];
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const results: GithubReviewResult[] = [];
    let calls = 0;
    const ctx = createFakePluginContext({
      source: "github-reviews",
      reply: async ({ key }) => {
        await complete(ctx, key!);
        calls++;
        if (calls === 1) {
          started.resolve();
          await release.promise;
        }
        return "Finished";
      },
    });
    const plugin = githubReviews({
      enabled: true,
      repositories: [{ name: Repository, skill: "review" }],
      reviewsDirectory: directory,
      maxConcurrentReviews: 1,
      github: { execute: fixture.execute },
      onRunComplete: (result) => {
        results.push(result);
      },
    });
    await plugin.start!(ctx);
    plugins.push(plugin);
    try {
      await invoke(plugin, "github_reviews_poll");
      await started.promise;
      expect(ctx.turns).toHaveLength(1);
      expect(ctx.turns[0].prompt).toContain("/pull/42");
      release.resolve();
      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(results.map((result) => result.selection.run.number)).toEqual([42, 43]);
      expect(ctx.sessions.list()).toHaveLength(0);
    } finally {
      release.resolve();
    }
  });

  test("pausing during in-flight eligibility validation prevents admission", async () => {
    const fixture = createGithubFixture();
    const inspected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute: GithubExecute = async (args, input, signal) => {
      if (input?.includes("InspectReview")) {
        inspected.resolve();
        await release.promise;
      }
      return fixture.execute(args, input, signal);
    };
    const current = await start(execute);
    const poll = invoke(current.plugin, "github_reviews_poll");
    await inspected.promise;
    await invoke(current.plugin, "github_reviews_pause");
    release.resolve();
    await poll;
    expect(current.ctx.turns).toHaveLength(0);
  });

  test("real session management closes review workers and inherits agent model settings", async () => {
    const fixture = createGithubFixture();
    const runtime = new FakeRuntime({ reply: () => "Could not complete this review" });
    const results: GithubReviewResult[] = [];
    const plugin = githubReviews({
      enabled: true,
      repositories: [{ name: Repository, skill: "review" }],
      reviewsDirectory: directory,
      github: { execute: fixture.execute },
      onRunComplete: (result) => {
        results.push(result);
      },
    });
    const agent = createAgent({
      name: "review-lifecycle",
      dataDir: path.join(directory, "agent"),
      runtime,
      pi: { model: "local/example", thinking: "medium" },
      plugins: [plugin],
    });
    try {
      await agent.start({ handleSignals: false });
      await invoke(plugin, "github_reviews_poll");
      await vi.waitFor(() => expect(results).toHaveLength(1));
      expect(results[0].status).toBe("blocked");
      expect(runtime.spawns).toHaveLength(1);
      expect(runtime.spawns[0].process.alive).toBe(false);
      expect(runtime.spawns[0].spec.ref.source).toBe("github-reviews");
      expect(runtime.spawns[0].spec.pi).toMatchObject({
        model: "local/example",
        thinking: "medium",
      });
      expect(runtime.spawns[0].spec.cwd).toBe(results[0].selection.artifactDirectory);
      expect(
        runtime.spawns[0].spec.tools?.some((entry) => entry.name === "github_review_complete"),
      ).toBe(true);
    } finally {
      await agent.stop();
    }
  });
});
