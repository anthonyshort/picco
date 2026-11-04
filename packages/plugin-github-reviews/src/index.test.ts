import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFakePluginContext,
  FakeRuntime,
  type FakePluginContext,
} from "@picco-agent/core/testing";
import { createAgent, silentLogger, type Plugin, type ToolContext } from "@picco-agent/core";
import { z } from "zod";
import { githubReviews } from "./index.js";
import { GithubReviewSourceError, type GithubExecute } from "./github.js";
import type { GithubReviewsOptions } from "./types.js";

const Repository = "owner/project";
const Head = "a".repeat(40);
const GraphqlInputSchema = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});
const ToolContext: ToolContext = { caller: { kind: "host" }, logger: silentLogger() };
let directory: string;
let plugins: Plugin[];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "simple-reviews-"));
  plugins = [];
});
afterEach(async () => {
  for (const plugin of plugins.reverse()) await plugin.stop?.();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function createGithubFixture() {
  const limit: { operation: "resolve" | "inspect" | null; retryAfterMs: number } = {
    operation: null,
    retryAfterMs: 1_000,
  };
  const state = {
    reviewer: "reviewer",
    numbers: [42],
    head: Head,
    request: "request:first",
    requestedAt: "2026-10-25T12:00:00Z",
    ready: true,
    timeline: true,
    remaining: 4000,
    inspectionRemaining: 4000,
    fail: false,
    empty: false,
  };
  const calls: string[] = [];
  const reads: string[][] = [];
  const execute: GithubExecute = async (args, input) => {
    reads.push(args);
    if (args[1] === "user") return JSON.stringify({ login: state.reviewer });
    if (args[1]?.startsWith("repos/")) {
      if (limit.operation === "resolve")
        throw new GithubReviewSourceError("GitHub rate limit", limit.retryAfterMs);
      if (state.fail) throw new Error("GitHub unavailable");
      const number = Number(args[1].split("/").at(-1));
      return JSON.stringify({
        number,
        title: "Requested change",
        html_url: `https://github.com/${Repository}/pull/${number}`,
        created_at: "2026-10-25T10:00:00Z",
        state: "open",
        draft: false,
        head: { sha: state.head },
        base: { sha: "b".repeat(40) },
      });
    }
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
    if (limit.operation === "inspect")
      throw new GithubReviewSourceError("GitHub rate limit", limit.retryAfterMs);
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
        rateLimit: { ...rateLimit, remaining: state.inspectionRemaining },
      },
    });
  };
  return { state, calls, reads, limit, execute };
}

async function invoke(plugin: Plugin, name: string, input = {}) {
  const selected = plugin.tools!.find((entry) => entry.name === name)!;
  return JSON.parse(String(await selected.execute(selected.input.parse(input), ToolContext)));
}

async function finish(
  ctx: FakePluginContext,
  key: string,
  value = {
    status: "completed",
    summary: "Reviewed",
    result: JSON.stringify({ markdown: "Full report" }),
  },
) {
  const selected = ctx.sessionTools
    .find((entry) => entry.key === key)!
    .tools.find((entry) => entry.name === "github_review_finish")!;
  return selected.execute(selected.input.parse(value), {
    caller: { kind: "session", ref: { source: "github-reviews", key } },
    logger: silentLogger(),
  });
}

async function start(
  options: Partial<GithubReviewsOptions> = {},
  reply?: (ctx: FakePluginContext, key: string) => Promise<string>,
  fixture = createGithubFixture(),
) {
  const starts: string[] = [];
  const ends: string[] = [];
  const ctx = createFakePluginContext({
    source: "github-reviews",
    reply: async ({ key }) => {
      if (reply) return reply(ctx, key!);
      await finish(ctx, key!);
      return "Done";
    },
  });
  const plugin = githubReviews({
    enabled: true,
    repositories: [{ name: Repository, skill: "review" }],
    reviewsDirectory: directory,
    github: { execute: fixture.execute },
    onRunStart: ({ run }) => {
      starts.push(run.id);
    },
    onRunComplete: ({ selection }) => {
      ends.push(selection.run.id);
    },
    ...options,
  });
  await plugin.start!(ctx);
  plugins.push(plugin);
  return { ...fixture, ctx, plugin, starts, ends };
}

async function idle(plugin: Plugin) {
  await vi.waitFor(async () =>
    expect((await invoke(plugin, "github_reviews_status")).activeRuns).toEqual([]),
  );
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function realHost(
  fixture: ReturnType<typeof createGithubFixture>,
  mode: "wait" | "complete" | "failed",
  enabled = false,
  options: Partial<GithubReviewsOptions> = {},
  afterFinish?: () => Promise<void>,
) {
  const responseSchema = z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })).max(10),
  });
  const runtime = new FakeRuntime({
    neverFinish: mode === "wait",
    async reply() {
      const spawn = runtime.spawns.at(-1)!;
      const response = await fetch(spawn.spec.bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${spawn.spec.bridge.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "github_review_finish",
          args: {
            status: mode === "failed" ? "failed" : "completed",
            summary: mode === "failed" ? undefined : "Done",
            error: mode === "failed" ? "Incomplete evidence" : undefined,
            result: JSON.stringify({ markdown: "Full report" }),
          },
        }),
      });
      expect(responseSchema.parse(await response.json()).isError).toBe(false);
      await afterFinish?.();
      return "Finished";
    },
  });
  const plugin = githubReviews({
    enabled,
    repositories: [{ name: Repository, skill: "review" }],
    reviewsDirectory: directory,
    github: { execute: fixture.execute },
    resultSchema: z.object({ markdown: z.string() }),
    maxConcurrentReviews: 1,
    ...options,
  });
  const agent = createAgent({
    name: "automatic-reviews",
    dataDir: path.join(directory, "agent"),
    runtime,
    plugins: [plugin],
    logger: silentLogger(),
  });
  await agent.start({ handleSignals: false });
  return {
    agent,
    runtime,
    plugin,
    call: (name: string, input = {}) => invoke(plugin, name, input),
    stop: () => agent.stop(),
  };
}

async function pollReview(plugin: Plugin) {
  await invoke(plugin, "github_reviews_poll");
  return (await invoke(plugin, "github_reviews_list"))[0];
}
describe("GitHub reviews plugin", () => {
  test.each([true, false])(
    "polling handles a request once across commits and restart, timeline=%s",
    async (timeline) => {
      const current = await start({ enabled: true });
      current.state.timeline = timeline;
      await invoke(current.plugin, "github_reviews_poll");
      await vi.waitFor(() => expect(current.ends).toHaveLength(1));
      await idle(current.plugin);
      const first = (await invoke(current.plugin, "github_reviews_list"))[0];
      current.state.head = "c".repeat(40);
      vi.setSystemTime(new Date("2026-10-26T12:02:00Z"));
      await invoke(current.plugin, "github_reviews_poll");
      expect(current.ctx.turns).toHaveLength(1);
      await current.plugin.stop!();
      const restarted = await start({ enabled: true });
      restarted.state.head = "c".repeat(40);
      restarted.state.timeline = true;
      await invoke(restarted.plugin, "github_reviews_poll");
      expect(restarted.ctx.turns).toHaveLength(0);
      expect((await invoke(restarted.plugin, "github_reviews_list"))[0].id).toBe(first.id);
      restarted.state.request = "request:second";
      restarted.state.requestedAt = "2026-10-26T12:03:00Z";
      vi.setSystemTime(new Date("2026-10-26T12:04:00Z"));
      await invoke(restarted.plugin, "github_reviews_poll");
      await vi.waitFor(() => expect(restarted.ends).toHaveLength(1));
      expect(await invoke(restarted.plugin, "github_reviews_list")).toHaveLength(2);
    },
  );

  test("a failed polling review stays stopped when a commit changes", async () => {
    const current = await start({ enabled: true }, async () => {
      throw new Error("Model authentication failed");
    });
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(async () =>
      expect((await invoke(current.plugin, "github_reviews_list"))[0]?.status).toBe("failed"),
    );
    current.state.head = "c".repeat(40);
    vi.setSystemTime(new Date("2026-10-26T12:02:00Z"));
    await invoke(current.plugin, "github_reviews_poll");
    expect(current.ctx.turns).toHaveLength(1);
    expect(
      (
        await invoke(current.plugin, "github_reviews_details", {
          id: (await invoke(current.plugin, "github_reviews_list"))[0].id,
        })
      ).runs[0].error,
    ).toContain("authentication");
  });

  test("a request after declared completion is accepted before old worker cleanup finishes", async () => {
    const hold = gate();
    const current = await start({ enabled: true, maxConcurrentReviews: 1 }, async (ctx, key) => {
      await finish(ctx, key);
      await hold.promise;
      return "Done";
    });
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(async () =>
      expect((await invoke(current.plugin, "github_reviews_list"))[0]?.status).toBe("completed"),
    );
    current.state.request = "request:new";
    current.state.requestedAt = "2026-10-26T12:01:00Z";
    vi.setSystemTime(new Date("2026-10-26T12:02:00Z"));
    await invoke(current.plugin, "github_reviews_poll");
    expect(await invoke(current.plugin, "github_reviews_list")).toHaveLength(2);
    expect(current.ctx.turns).toHaveLength(1);
    hold.resolve();
    await vi.waitFor(() => expect(current.ctx.turns).toHaveLength(2));
    await idle(current.plugin);
  });

  test("plain output cannot declare completion and retries retain previous errors", async () => {
    const current = await start({}, async () => "Review complete");
    const job = await pollReview(current.plugin);
    await vi.waitFor(async () =>
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: job.id })).job.status,
      ).toBe("failed"),
    );
    await idle(current.plugin);
    await invoke(current.plugin, "github_reviews_retry", { id: job.id });
    await vi.waitFor(async () =>
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: job.id })).runs,
      ).toHaveLength(2),
    );
    await idle(current.plugin);
    expect(
      (await invoke(current.plugin, "github_reviews_details", { id: job.id })).runs.every(
        (run: { status: string }) => run.status === "failed",
      ),
    ).toBe(true);
  });

  test("pause is in memory and worker slots remain held until teardown", async () => {
    const hold = gate();
    const current = await start({ maxConcurrentReviews: 1 }, async (ctx, key) => {
      await finish(ctx, key);
      await hold.promise;
      return "Done";
    });
    current.state.numbers = [42, 43];
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.ctx.turns).toHaveLength(1));
    expect(await invoke(current.plugin, "github_reviews_list")).toHaveLength(2);
    await invoke(current.plugin, "github_reviews_pause");
    hold.resolve();
    await idle(current.plugin);
    expect(current.ctx.turns).toHaveLength(1);
    await current.plugin.stop!();
    const restarted = await start();
    await vi.waitFor(() => expect(restarted.ctx.turns).toHaveLength(1));
    expect((await invoke(restarted.plugin, "github_reviews_status")).paused).toBe(false);
  });

  test("a worker cannot finish another session and required reports are validated atomically", async () => {
    const current = await start(
      {
        resultSchema: z.object({ markdown: z.string() }),
      },
      async (ctx, key) => {
        const selected = ctx.sessionTools
          .find((entry) => entry.key === key)!
          .tools.find((entry) => entry.name === "github_review_finish")!;
        await expect(
          selected.execute(
            selected.input.parse({ status: "completed", summary: "Done" }),
            ToolContext,
          ),
        ).rejects.toThrow("selected");
        await expect(
          finish(ctx, key, { status: "completed", summary: "Done", result: "{}" }),
        ).rejects.toThrow();
        await finish(ctx, key);
        return "Done";
      },
    );
    const job = await pollReview(current.plugin);
    await vi.waitFor(async () =>
      expect(
        (await invoke(current.plugin, "github_reviews_report", { id: job.id })).report,
      ).toEqual({ markdown: "Full report" }),
    );
    await idle(current.plugin);
    expect(
      (await invoke(current.plugin, "github_reviews_details", { id: job.id })).job.status,
    ).toBe("completed");
  });

  test("real agent shutdown restarts unfinished automatic reviews at current revisions", async () => {
    const fixture = createGithubFixture();
    const first = await realHost(fixture, "wait", true);
    let id: string;
    try {
      await first.call("github_reviews_poll");
      await vi.waitFor(async () => expect(await first.call("github_reviews_list")).toHaveLength(1));
      id = (await first.call("github_reviews_list"))[0].id;
      await vi.waitFor(() => expect(first.runtime.spawns).toHaveLength(1));
    } finally {
      await first.stop();
    }
    fixture.state.head = "c".repeat(40);
    const second = await realHost(fixture, "complete", true);
    try {
      await vi.waitFor(async () =>
        expect((await second.call("github_reviews_details", { id })).job.status).toBe("completed"),
      );
      const details = await second.call("github_reviews_details", { id });
      expect(details.runs).toHaveLength(2);
      expect(details.runs[0].head).toBe("c".repeat(40));
      expect(details.runs[1].status).toBe("interrupted");
      expect(details.runs[0].sessionKey).not.toBe(details.runs[1].sessionKey);
      expect((await second.call("github_reviews_report", { id })).report).toEqual({
        markdown: "Full report",
      });
      expect(second.plugin.mcpTools).toBeUndefined();
    } finally {
      await second.stop();
    }
    const third = await realHost(fixture, "complete", true);
    try {
      await third.call("github_reviews_poll");
      expect((await third.call("github_reviews_details", { id })).job.status).toBe("completed");
      expect(third.runtime.spawns).toHaveLength(0);
    } finally {
      await third.stop();
    }
  });

  test("manual cancellation remains stopped after a real agent restart", async () => {
    const fixture = createGithubFixture();
    const first = await realHost(fixture, "wait", true);
    let id: string;
    try {
      await first.call("github_reviews_poll");
      id = (await first.call("github_reviews_list"))[0].id;
      await vi.waitFor(() => expect(first.runtime.spawns).toHaveLength(1));
      expect((await first.call("github_reviews_cancel", { id })).job.status).toBe("cancelled");
    } finally {
      await first.stop();
    }
    const second = await realHost(fixture, "complete", true);
    try {
      expect((await second.call("github_reviews_details", { id })).job.status).toBe("cancelled");
      expect(second.runtime.spawns).toHaveLength(0);
    } finally {
      await second.stop();
    }
  });

  test("a newer request queued before earlier completion is not reviewed twice", async () => {
    const beforeFinish = gate();
    const current = await start({ enabled: true, maxConcurrentReviews: 1 }, async (ctx, key) => {
      await beforeFinish.promise;
      await finish(ctx, key);
      return "Done";
    });
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.ctx.turns).toHaveLength(1));
    vi.setSystemTime(new Date("2026-10-26T12:02:00Z"));
    current.state.request = "request:second";
    current.state.requestedAt = "2026-10-26T12:01:00Z";
    await invoke(current.plugin, "github_reviews_poll");
    expect(await invoke(current.plugin, "github_reviews_list")).toHaveLength(2);
    beforeFinish.resolve();
    await idle(current.plugin);
    await vi.waitFor(async () =>
      expect((await invoke(current.plugin, "github_reviews_list"))[0].status).toBe("cancelled"),
    );
    expect(current.ctx.turns).toHaveLength(1);
  });

  test.each([false, true])(
    "queued automatic jobs obey disabled or removed repository configuration, removed=%s",
    async (removed) => {
      const first = await start({ enabled: true });
      await invoke(first.plugin, "github_reviews_pause");
      await invoke(first.plugin, "github_reviews_poll");
      const job = (await invoke(first.plugin, "github_reviews_list"))[0];
      expect(job.status).toBe("queued");
      await first.plugin.stop!();
      const second = await start({
        enabled: removed,
        repositories: removed ? [{ name: "owner/other", skill: "review" }] : [],
      });
      expect(second.ctx.turns).toHaveLength(0);
      expect(
        (await invoke(second.plugin, "github_reviews_details", { id: job.id })).job.status,
      ).toBe("queued");
    },
  );

  test("automatic jobs share capacity while notification errors do not repeat work", async () => {
    const hold = gate();
    const current = await start(
      {
        enabled: true,
        maxConcurrentReviews: 1,
        onRunStart() {
          throw new Error("Notification unavailable");
        },
        onRunComplete() {
          throw new Error("Notification unavailable");
        },
      },
      async (ctx, key) => {
        await hold.promise;
        await finish(ctx, key);
        return "Done";
      },
    );
    current.state.numbers = [42, 43];
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.ctx.turns).toHaveLength(1));
    expect(await invoke(current.plugin, "github_reviews_list")).toHaveLength(2);
    expect(current.ctx.turns).toHaveLength(1);
    hold.resolve();
    await vi.waitFor(() => expect(current.ctx.turns).toHaveLength(2));
    await idle(current.plugin);
    expect(
      (await invoke(current.plugin, "github_reviews_list")).every(
        (job: { status: string }) => job.status === "completed",
      ),
    ).toBe(true);
  });

  test("inspection rate limits stop further polling requests", async () => {
    const current = await start({ enabled: true });
    current.state.numbers = [42, 43];
    current.state.inspectionRemaining = 0;
    await invoke(current.plugin, "github_reviews_poll");
    const reads = current.calls.length;
    expect(reads).toBe(2);
    await invoke(current.plugin, "github_reviews_poll");
    expect(current.calls).toHaveLength(reads);
    expect(current.ctx.turns).toHaveLength(0);
  });

  test("retry during a failed worker's cleanup cannot enqueue a second attempt", async () => {
    const cleanup = gate();
    const current = await start({}, async (ctx, key) => {
      const selected = ctx.sessionTools
        .find((entry) => entry.key === key)!
        .tools.find((entry) => entry.name === "github_review_finish")!;
      await selected.execute(
        selected.input.parse({
          status: "failed",
          error: "Incomplete evidence",
          result: JSON.stringify({ markdown: "Partial report" }),
        }),
        {
          caller: { kind: "session", ref: { source: "github-reviews", key } },
          logger: silentLogger(),
        },
      );
      await cleanup.promise;
      return "Failed";
    });
    const job = await pollReview(current.plugin);
    await vi.waitFor(async () =>
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: job.id })).job.status,
      ).toBe("failed"),
    );
    expect((await invoke(current.plugin, "github_reviews_retry", { id: job.id })).job.status).toBe(
      "failed",
    );
    cleanup.resolve();
    await idle(current.plugin);
    expect(current.ctx.turns).toHaveLength(1);
    expect((await invoke(current.plugin, "github_reviews_report", { id: job.id })).report).toEqual({
      markdown: "Partial report",
    });
  });

  test("worker cleanup failure preserves a recorded completion and reports the failure", async () => {
    const current = await start();
    current.ctx.sessions.reset = async () => {
      throw new Error("Worker termination failed");
    };
    const job = await pollReview(current.plugin);
    await vi.waitFor(async () =>
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: job.id })).runs[0]
          ?.cleanupError,
      ).toContain("termination"),
    );
    await idle(current.plugin);
    expect(
      (await invoke(current.plugin, "github_reviews_details", { id: job.id })).job.status,
    ).toBe("completed");
    expect((await invoke(current.plugin, "github_reviews_status")).paused).toBe(true);
  });
  test.each(["resolve", "inspect"] as const)(
    "known %s limits retain queued work and resume after backoff and restart",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
      const fixture = createGithubFixture();
      fixture.state.numbers = [42, 43];
      const current = await start({ enabled: true }, undefined, fixture);
      await invoke(current.plugin, "github_reviews_pause");
      await invoke(current.plugin, "github_reviews_poll");
      fixture.limit.operation = operation;
      await invoke(current.plugin, "github_reviews_resume");
      await vi.advanceTimersByTimeAsync(0);
      const jobs = await invoke(current.plugin, "github_reviews_list");
      expect(jobs.map((job: { status: string }) => job.status)).toEqual(["queued", "queued"]);
      for (const job of jobs)
        expect(
          (await invoke(current.plugin, "github_reviews_details", { id: job.id })).runs,
        ).toEqual([]);
      const reads = fixture.reads.length;
      await invoke(current.plugin, "github_reviews_poll");
      await invoke(current.plugin, "github_reviews_retry", { id: jobs[0].id });
      await vi.advanceTimersByTimeAsync(999);
      expect(fixture.reads).toHaveLength(reads);
      expect(current.ctx.turns).toEqual([]);
      await current.plugin.stop!();

      const restarted = await start({ enabled: true }, undefined, fixture);
      await vi.advanceTimersByTimeAsync(0);
      expect((await invoke(restarted.plugin, "github_reviews_status")).retryAt).not.toBeNull();
      const restartReads = fixture.reads.length;
      await invoke(restarted.plugin, "github_reviews_poll");
      await vi.advanceTimersByTimeAsync(999);
      expect(fixture.reads).toHaveLength(restartReads);
      fixture.limit.operation = null;
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(restarted.ctx.turns).toHaveLength(2));
      expect(
        (await invoke(restarted.plugin, "github_reviews_list")).map(
          (job: { status: string }) => job.status,
        ),
      ).toEqual(["completed", "completed"]);
    },
  );

  test.each(["complete", "failed"] as const)(
    "cancel awaits an active worker after its %s outcome without erasing the report",
    async (mode) => {
      const fixture = createGithubFixture();
      const execution = gate();
      const notification = gate();
      const notified = gate();
      const host = await realHost(
        fixture,
        mode,
        true,
        {
          onRunComplete: () => {
            notified.resolve();
            return notification.promise;
          },
        },
        () => execution.promise,
      );
      try {
        await host.call("github_reviews_poll");
        await vi.waitFor(async () =>
          expect((await host.call("github_reviews_list"))[0]?.status).toBe(
            mode === "complete" ? "completed" : "failed",
          ),
        );
        const job = (await host.call("github_reviews_list"))[0];
        let returned = false;
        const cancelled = host.call("github_reviews_cancel", { id: job.id }).then((result) => {
          returned = true;
          return result;
        });
        await notified.promise;
        expect(host.runtime.spawns[0].process.alive).toBe(false);
        expect(returned).toBe(false);
        notification.resolve();
        const result = await cancelled;
        expect(result.job.status).toBe(mode === "complete" ? "completed" : "failed");
        expect(result.runs[0].report).toEqual({ markdown: "Full report" });
        expect((await host.call("github_reviews_status")).activeRuns).toEqual([]);
      } finally {
        execution.resolve();
        notification.resolve();
        await host.stop();
      }
    },
  );

  test("a real review timeout is saved as failure rather than restarted automatically", async () => {
    const fixture = createGithubFixture();
    const host = await realHost(fixture, "wait", true, { reviewTimeoutMs: 1_000 });
    try {
      await host.call("github_reviews_poll");
      await vi.waitFor(
        async () => expect((await host.call("github_reviews_list"))[0]?.status).toBe("failed"),
        { timeout: 3_000 },
      );
      const job = (await host.call("github_reviews_list"))[0];
      expect((await host.call("github_reviews_details", { id: job.id })).runs[0].error).toMatch(
        /timed out|timeout/i,
      );
      vi.setSystemTime(new Date("2026-10-26T12:02:00Z"));
      await host.call("github_reviews_poll");
      expect(host.runtime.spawns).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  test("saved completion and its report survive a later worker error", async () => {
    const current = await start(
      { resultSchema: z.object({ markdown: z.string() }) },
      async (ctx, key) => {
        await finish(ctx, key);
        throw new Error("Worker disconnected after completion");
      },
    );
    const job = await pollReview(current.plugin);
    await idle(current.plugin);
    const saved = await invoke(current.plugin, "github_reviews_details", { id: job.id });
    expect(saved.job.status).toBe("completed");
    expect(saved.runs[0].report).toEqual({ markdown: "Full report" });
    expect(saved.runs[0].error).toContain("disconnected");
  });
});
