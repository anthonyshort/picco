import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgent, silentLogger, type Plugin, type ToolContext } from "@picco-agent/core";
import { FakeRuntime } from "@picco-agent/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { githubReviews, type GithubExecute, type GithubReviewResult } from "./index.js";
import { createReviewStore } from "./store.js";

/**
 * Stable repository identity for local-only and automatically discovered work.
 */
const Repository = "owner/project";
const Url = `https://github.com/${Repository}/pull/42`;
const Candidate = {
  repository: Repository,
  number: 42,
  url: Url,
  title: "Change",
  head: "a".repeat(40),
  createdAt: new Date().toISOString(),
};
const Host: ToolContext = { caller: { kind: "host" }, logger: silentLogger() };
const ResponseSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).max(10),
});
let directory: string;
let cleanup: (() => Promise<void>)[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "native-review-jobs-"));
  cleanup = [];
});
afterEach(async () => {
  for (const stop of cleanup.reverse()) await stop();
  await rm(directory, { recursive: true, force: true });
});

/**
 * Supply real transport responses without GitHub credentials or network calls.
 */
function githubFixture(head = Candidate.head) {
  const calls: string[][] = [];
  const execute: GithubExecute = async (args, input) => {
    calls.push(args);
    if (args[1] === "user") return JSON.stringify({ login: "reviewer" });
    if (args[1]?.startsWith("repos/")) {
      const number = Number(args[1].split("/").at(-1));
      return JSON.stringify({
        number,
        title: "Change",
        html_url: `https://github.com/${Repository}/pull/${number}`,
        created_at: Candidate.createdAt,
        state: "open",
        draft: false,
        head: { sha: head },
        base: { sha: "b".repeat(40) },
      });
    }
    const request = z.object({ query: z.string() }).parse(JSON.parse(input!));
    const pull = {
      number: 42,
      title: Candidate.title,
      url: Url,
      headRefOid: head,
      createdAt: Candidate.createdAt,
      isDraft: false,
      state: "OPEN",
      repository: { nameWithOwner: Repository },
    };
    const rateLimit = {
      cost: 1,
      remaining: 4000,
      resetAt: new Date(Date.now() + 3600000).toISOString(),
    };
    if (request.query.includes("RequestedReviews"))
      return JSON.stringify({
        data: {
          viewer: { login: "reviewer" },
          repository0: { nameWithOwner: Repository, pullRequests: { totalCount: 1 } },
          search: {
            issueCount: 1,
            nodes: [pull],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          rateLimit,
        },
      });
    return JSON.stringify({
      data: {
        viewer: { login: "reviewer" },
        repository: {
          nameWithOwner: Repository,
          pullRequest: {
            ...pull,
            reviewRequests: {
              nodes: [{ requestedReviewer: { login: "reviewer" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            timelineItems: {
              nodes: [
                {
                  id: "request:first",
                  createdAt: Candidate.createdAt,
                  requestedReviewer: { login: "reviewer" },
                },
              ],
              pageInfo: { hasPreviousPage: false, startCursor: null },
            },
          },
        },
        rateLimit,
      },
    });
  };
  return { execute, calls };
}

/**
 * Call a native management tool with the same parser used by its bridge.
 */
async function invoke(plugin: Plugin, name: string, input = {}, context = Host) {
  const selected = plugin.tools!.find((entry) => entry.name === name)!;
  return JSON.parse(z.string().parse(await selected.execute(selected.input.parse(input), context)));
}

/**
 * Start a real core MCP listener and session manager with scripted worker processes.
 */
async function start(
  mode: "wait" | "complete" | "partial" = "wait",
  enabled = false,
  head = Candidate.head,
) {
  const github = githubFixture(head);
  const results: GithubReviewResult[] = [];
  let completionRejected = false;
  const runtime: FakeRuntime = new FakeRuntime({
    neverFinish: mode === "wait",
    async reply() {
      if (mode === "wait") return "Working";
      const spawn = runtime.spawns.at(-1)!;
      const bridge = async (tool: string, args: unknown) => {
        const response = await fetch(spawn.spec.bridge.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${spawn.spec.bridge.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tool, args }),
        });
        return ResponseSchema.parse(await response.json());
      };
      expect(
        (
          await bridge("github_review_result", {
            result: JSON.stringify({ complete: mode === "complete", report: "x".repeat(15000) }),
          })
        ).isError,
      ).toBe(false);
      completionRejected =
        (await bridge("github_review_complete", { summary: "Review finished" })).isError === true;
      return "Finished";
    },
  });
  const plugin = githubReviews({
    enabled,
    repositories: enabled ? [{ name: Repository, skill: "review" }] : [],
    reviewsDirectory: directory,
    maxConcurrentReviews: 1,
    github: { execute: github.execute },
    validateResult(value) {
      const parsed = z.object({ complete: z.boolean() }).passthrough().parse(value);
      return { complete: parsed.complete, value };
    },
    onRunComplete(result) {
      results.push(result);
    },
  });
  let url = "";
  const agent = createAgent({
    name: "native-review-jobs",
    dataDir: path.join(directory, "agent"),
    runtime,
    plugins: [plugin],
    mcp: { port: 0, token: "test-token" },
    logger: {
      ...silentLogger(),
      log(message, data) {
        if (message === "MCP listening") url = z.string().parse(data?.url);
      },
    },
  });
  await agent.start({ handleSignals: false });
  cleanup.push(() => agent.stop());
  const client = new Client({ name: "native-review-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: "Bearer test-token" } },
    }),
  );
  cleanup.push(() => client.close());
  return {
    agent,
    plugin,
    runtime,
    client,
    results,
    github,
    completionRejected: () => completionRejected,
  };
}

/**
 * Decode the text result exposed through the actual MCP SDK client.
 */
async function mcp(client: Client, name: string, input = {}) {
  const response = ResponseSchema.parse(await client.callTool({ name, arguments: input }));
  if (response.isError) throw new Error(response.content[0]!.text);
  return JSON.parse(response.content[0]!.text);
}

describe("native review job ownership", () => {
  test("tool and MCP starts share one durable job while polling is disabled", async () => {
    const current = await start();
    const first = await mcp(current.client, "github_reviews_start", {
      url: Url,
      requestId: "same-request",
    });
    const replay = await invoke(current.plugin, "github_reviews_start", {
      url: Url,
      requestId: "same-request",
    });
    expect(replay.id).toBe(first.id);
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(1));
    expect(current.runtime.spawns[0]!.spec.ref.source).toBe("github-reviews");
    const doctor = await mcp(current.client, "github_reviews_doctor");
    expect(doctor.explicit).toHaveLength(1);
    expect(doctor.explicit[0]).toMatchObject({
      source: "mcp",
      delivery: "local-only",
      status: "running",
    });
    expect(current.github.calls).toHaveLength(4);
    expect(
      (await current.client.listTools()).tools.some(
        (tool) => tool.name === "github_review_complete",
      ),
    ).toBe(false);
    await expect(
      invoke(
        current.plugin,
        "github_reviews_start",
        { url: Url, requestId: "worker-fanout" },
        {
          caller: { kind: "session", ref: { source: "github-reviews", key: "other" } },
          logger: silentLogger(),
        },
      ),
    ).rejects.toThrow("cannot control");
    await mcp(current.client, "github_reviews_cancel", { id: first.id });
    expect(current.runtime.spawns[0]!.process.alive).toBe(false);
  });

  test("other agent sessions cannot access review-only completion tools", async () => {
    const current = await start();
    const turn = current.agent.sessions.run("unrelated-chat", "Attempt an unrelated task");
    void turn.catch(() => {});
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(1));
    const spawn = current.runtime.spawns[0]!;
    expect(spawn.spec.ref.source).not.toBe("github-reviews");
    const response = await fetch(spawn.spec.bridge.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${spawn.spec.bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: "github_review_complete",
        args: { summary: "Forged completion" },
      }),
    });
    expect(ResponseSchema.parse(await response.json()).isError).toBe(true);
    expect(spawn.spec.tools?.some((tool) => tool.name === "github_review_result")).toBe(false);
  });

  test.each(["complete", "partial"] as const)(
    "captures a full %s result without touching automatic completion evidence",
    async (mode) => {
      const current = await start(mode);
      const job = await mcp(current.client, "github_reviews_start", { url: Url, requestId: mode });
      await vi.waitFor(() => expect(current.results).toHaveLength(1));
      expect(current.results[0]!.status).toBe(mode === "complete" ? "completed" : "blocked");
      expect(current.completionRejected()).toBe(mode === "partial");
      const report = await mcp(current.client, "github_reviews_report", { id: job.id });
      expect(report.capture.value.report).toHaveLength(15000);
      expect(report.run).toMatchObject({ source: "mcp", delivery: "local-only" });
      const database = new DatabaseSync(path.join(directory, "reviews.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM reviewed_commits").all()).toEqual([]);
        expect(database.prepare("SELECT * FROM review_claims").all()).toEqual([]);
      } finally {
        database.close();
      }
      expect(current.runtime.spawns[0]!.process.alive).toBe(false);
    },
  );

  test("local completion preserves automatic completion history", async () => {
    const persisted = createReviewStore(path.join(directory, "reviews.sqlite"));
    persisted.reconcile("reviewer", [Candidate]);
    const automatic = persisted.admit(persisted.next()[0]!.id, "reviewer", 1)!;
    persisted.markReviewed(automatic.id, "Previously published");
    persisted.finish(automatic.id, { status: "interrupted" });
    persisted.close();
    const database = new DatabaseSync(path.join(directory, "reviews.sqlite"));
    const claims = database.prepare("SELECT * FROM review_claims").all();
    const reviewed = database.prepare("SELECT * FROM reviewed_commits").all();
    const current = await start("complete");
    try {
      const job = await mcp(current.client, "github_reviews_start", {
        url: Url,
        requestId: "same-pr-local",
      });
      await vi.waitFor(() => expect(current.results).toHaveLength(1));
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: job.id })).job.status,
      ).toBe("completed");
      expect(database.prepare("SELECT * FROM review_claims").all()).toEqual(claims);
      expect(database.prepare("SELECT * FROM reviewed_commits").all()).toEqual(reviewed);
    } finally {
      database.close();
    }
  });

  test("polled and explicit workers share one concurrency slot", async () => {
    const current = await start("wait", true);
    await invoke(current.plugin, "github_reviews_poll");
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(1));
    const explicit = await mcp(current.client, "github_reviews_start", {
      url: Url.replace("42", "43"),
      requestId: "manual",
    });
    expect(explicit.status).toBe("queued");
    expect(current.runtime.spawns).toHaveLength(1);
    const automaticId = (await invoke(current.plugin, "github_reviews_doctor")).activeRuns[0];
    await invoke(current.plugin, "github_reviews_cancel", { id: automaticId });
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(2));
    expect(
      (await invoke(current.plugin, "github_reviews_details", { id: explicit.id })).job.status,
    ).toBe("running");
    const database = new DatabaseSync(path.join(directory, "reviews.sqlite"));
    try {
      expect(database.prepare("SELECT * FROM review_claims").all()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("cancel reports a worker kill failure without stalling other jobs", async () => {
    const current = await start();
    const first = await mcp(current.client, "github_reviews_start", {
      url: Url,
      requestId: "failure",
    });
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(1));
    const process = current.runtime.spawns[0]!.process;
    await vi.waitFor(() => expect(process.prompts).toHaveLength(1));
    const kill = process.kill.bind(process);
    process.kill = async () => {
      throw new Error("Worker termination failed");
    };
    try {
      await mcp(current.client, "github_reviews_start", {
        url: Url.replace("42", "43"),
        requestId: "queued",
      });
      const cancellation = await current.client.callTool({
        name: "github_reviews_cancel",
        arguments: { id: first.id },
      });
      expect(cancellation).toMatchObject({ isError: true });
      expect(process.alive).toBe(true);
      expect(
        (await invoke(current.plugin, "github_reviews_details", { id: first.id })).job.status,
      ).toBe("interrupted");
      await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(2));
    } finally {
      process.kill = kill;
      await kill();
    }
  });

  test("restart abandons the old execution and admits a fresh current-head attempt", async () => {
    const original = createReviewStore(path.join(directory, "reviews.sqlite"));
    const job = original.jobs.submit({
      requestId: "before-restart",
      url: Url,
      candidate: { ...Candidate, head: "c".repeat(40) },
      base: "d".repeat(40),
      reviewer: "reviewer",
      source: "tool",
      delivery: "local-only",
      skill: "review",
    });
    const old = original.jobs.admit(job.id, "old-session")!;
    original.jobs.attempts.capture(old.id, {
      complete: false,
      value: { report: "saved before restart" },
    });
    original.close();
    const current = await start();
    await vi.waitFor(() => expect(current.runtime.spawns).toHaveLength(1));
    const replay = await mcp(current.client, "github_reviews_start", {
      url: Url,
      requestId: "before-restart",
    });
    expect(replay.id).toBe(job.id);
    const details = await invoke(current.plugin, "github_reviews_details", { id: job.id });
    expect(details.job.status).toBe("running");
    expect(details.runs).toHaveLength(2);
    expect(details.runs[0]).toMatchObject({
      id: old.id,
      status: "interrupted",
      reason: "runtime-restarted",
      head: "c".repeat(40),
    });
    expect(details.runs[1]).toMatchObject({
      status: "running",
      head: Candidate.head,
      base: "b".repeat(40),
    });
    expect(details.runs[1].sessionKey).not.toBe(old.sessionKey);
    expect(
      (await mcp(current.client, "github_reviews_report", { id: old.id })).capture.value,
    ).toEqual({ report: "saved before restart" });
    expect(current.runtime.spawns).toHaveLength(1);
  });

  test.each([false, true])(
    "normal stop/start creates a fresh attempt for automatic=%s and keeps cancelled work stopped",
    async (automatic) => {
      const first = await start("wait", automatic);
      let id: string;
      if (automatic) {
        await invoke(first.plugin, "github_reviews_poll");
        id = (await invoke(first.plugin, "github_reviews_list"))[0].id;
      } else {
        id = (
          await mcp(first.client, "github_reviews_start", { url: Url, requestId: "normal-restart" })
        ).id;
      }
      await vi.waitFor(() => expect(first.runtime.spawns).toHaveLength(1));
      const spawn = first.runtime.spawns[0]!;
      await vi.waitFor(() => expect(spawn.process.prompts).toHaveLength(1));
      const oldRun = (await invoke(first.plugin, "github_reviews_details", { id })).runs[0];
      const capture = await fetch(spawn.spec.bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${spawn.spec.bridge.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "github_review_result",
          args: { result: JSON.stringify({ complete: false, report: "saved before stopping" }) },
        }),
      });
      expect(ResponseSchema.parse(await capture.json()).isError).toBe(false);
      await first.agent.stop();
      const second = await start("wait", automatic, "c".repeat(40));
      if (automatic) await invoke(second.plugin, "github_reviews_poll");
      await vi.waitFor(() => expect(second.runtime.spawns).toHaveLength(1));
      const activeId = (await invoke(second.plugin, "github_reviews_doctor")).activeRuns[0];
      const current = await invoke(second.plugin, "github_reviews_details", { id: activeId });
      const fresh = current.runs.find((run: { id: string }) => run.id === activeId);
      expect(fresh.head).toBe("c".repeat(40));
      expect(fresh.sessionKey).not.toBe(oldRun.sessionKey);
      const old = await invoke(second.plugin, "github_reviews_details", { id: oldRun.id });
      expect(old.runs.find((run: { id: string }) => run.id === oldRun.id)).toMatchObject({
        status: "interrupted",
        reason: "runtime-restarted",
      });
      expect(
        (await mcp(second.client, "github_reviews_report", { id: oldRun.id })).capture.value.report,
      ).toBe("saved before stopping");
      if (!automatic)
        expect(
          (
            await mcp(second.client, "github_reviews_start", {
              url: Url,
              requestId: "normal-restart",
            })
          ).id,
        ).toBe(id);
      await mcp(second.client, "github_reviews_cancel", { id: activeId });
      await second.agent.stop();
      const third = await start("wait", automatic, "c".repeat(40));
      if (automatic) await invoke(third.plugin, "github_reviews_poll");
      expect(third.runtime.spawns).toHaveLength(0);
    },
  );
});
