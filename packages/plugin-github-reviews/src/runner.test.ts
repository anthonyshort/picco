import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { silentLogger } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContext } from "@picco-agent/core/testing";
import { runReview } from "./runner.js";
import type { ReviewJob, ReviewAttempt, ReviewFinish } from "./review-types.js";
import type { GithubReviewsOptions } from "./types.js";

interface RunnerFixtureOptions {
  options?: GithubReviewsOptions;
  delivery?: ReviewJob["delivery"];
  reply?: (ctx: FakePluginContext) => Promise<string>;
}

const directories: string[] = [];
const FINISH_TOOLS = ["github_review_finish", "github_review_complete"] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function startRunner(input: RunnerFixtureOptions = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-runner-"));
  directories.push(directory);
  const now = new Date().toISOString();
  const id = randomUUID();
  const job: ReviewJob = {
    id,
    requestKey: "one",
    source: "poll",
    repository: "example/widgets",
    number: 42,
    url: "https://github.com/example/widgets/pull/42",
    reviewer: "reviewer",
    requestEventId: null,
    requestedAt: null,
    skill: "review",
    delivery: input.delivery ?? "local-only",
    status: "running",
    createdAt: now,
    updatedAt: now,
    error: null,
  };
  const run: ReviewAttempt = {
    id: randomUUID(),
    itemId: id,
    repository: job.repository,
    number: job.number,
    title: "Change",
    url: job.url,
    head: "a".repeat(40),
    base: "b".repeat(40),
    createdAt: now,
    reviewer: job.reviewer,
    attempt: 1,
    sessionKey: "selected",
    startedAt: now,
    finishedAt: null,
    status: "running",
    summary: null,
    error: null,
    cleanupError: null,
    output: null,
    report: null,
  };
  const records: { outcome: ReviewFinish; report: unknown }[] = [];
  const ctx = createFakePluginContext({
    source: "github-reviews",
    reply: () => input.reply?.(ctx) ?? "Done",
  });
  const worker = runReview({
    ctx,
    job,
    run,
    reviewsDirectory: directory,
    options: input.options ?? {},
    recordOutcome: (outcome, report) => {
      records.push({ outcome, report });
    },
  });
  return { ctx, worker, records };
}

async function submit(ctx: FakePluginContext, name: string, input: object) {
  const selected = ctx.sessionTools[0].tools.find((entry) => entry.name === name)!;
  return selected.execute(selected.input.parse(input), {
    caller: { kind: "session", ref: { source: "github-reviews", key: "selected" } },
    logger: silentLogger(),
  });
}

function completed(name: string, result?: string) {
  return name === "github_review_finish"
    ? { status: "completed", summary: "Done", result }
    : { summary: "Done", result };
}

describe("review runner", () => {
  test("shutdown does not replace an earlier manual cancellation", async () => {
    const fixture = startRunner();
    fixture.worker.abort();
    fixture.worker.abort(true);
    expect((await fixture.worker.completion).cancellation).toBe("cancelled");
    expect(fixture.records).toEqual([]);
  });

  test.each(FINISH_TOOLS)(
    "%s validates required reports and records only an accepted report",
    async (name) => {
      const fixture = startRunner({
        options: { resultSchema: z.object({ markdown: z.string() }) },
        reply: async (ctx) => {
          for (const invalid of [undefined, "null", "{", "{}"])
            await expect(submit(ctx, name, completed(name, invalid))).rejects.toThrow();
          await submit(
            ctx,
            name,
            completed(name, JSON.stringify({ markdown: "Report", ignored: true })),
          );
          await expect(
            submit(ctx, name, completed(name, JSON.stringify({ markdown: "Replacement" }))),
          ).rejects.toThrow("already submitted");
          return "Done";
        },
      });
      const result = await fixture.worker.completion;
      expect(result.submitted?.status).toBe("completed");
      expect(fixture.records).toHaveLength(1);
      expect(fixture.records[0].report).toEqual({ markdown: "Report" });
    },
  );

  test.each([undefined, null])(
    "a schema cannot discard a required report to %s",
    async (output) => {
      const fixture = startRunner({
        options: { resultSchema: z.unknown().transform(() => output) },
        reply: async (ctx) => {
          await expect(
            submit(
              ctx,
              "github_review_finish",
              completed("github_review_finish", '{"markdown":"Report"}'),
            ),
          ).rejects.toThrow("report is required");
          return "No completion";
        },
      });
      expect((await fixture.worker.completion).submitted).toBeUndefined();
      expect(fixture.records).toEqual([]);
    },
  );

  test("failed work retains useful partial JSON without applying the complete-report schema", async () => {
    const partial = { evidence: ["One inspected file"] };
    const fixture = startRunner({
      options: { resultSchema: z.object({ markdown: z.string() }) },
      reply: async (ctx) => {
        await submit(ctx, "github_review_finish", {
          status: "failed",
          error: "Missing evidence",
          result: JSON.stringify(partial),
        });
        return "Stopped";
      },
    });
    expect((await fixture.worker.completion).submitted?.status).toBe("failed");
    expect(fixture.records[0].report).toEqual(partial);
  });

  test("direct skills can complete with a summary when no report schema is configured", async () => {
    const fixture = startRunner({
      reply: async (ctx) => {
        await submit(ctx, "github_review_complete", { summary: "Reviewed" });
        return "Done";
      },
    });
    expect((await fixture.worker.completion).submitted?.status).toBe("completed");
    expect(fixture.records).toEqual([
      { outcome: { status: "completed", summary: "Reviewed" }, report: null },
    ]);
  });

  test.each(FINISH_TOOLS)("%s enforces the UTF-8 limit at and beyond 4 MiB", async (name) => {
    const limit = 4 * 1024 * 1024;
    const exact = JSON.stringify("é".repeat((limit - 2) / 2));
    const oversized = JSON.stringify("é".repeat(limit / 2));
    expect(Buffer.byteLength(exact)).toBe(limit);
    expect(oversized.length).toBeLessThan(limit);
    const fixture = startRunner({
      options: { resultSchema: z.string() },
      reply: async (ctx) => {
        await expect(submit(ctx, name, completed(name, oversized))).rejects.toThrow("4 MiB");
        await submit(ctx, name, completed(name, exact));
        return "Done";
      },
    });
    expect((await fixture.worker.completion).submitted?.status).toBe("completed");
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0].report).toHaveLength((limit - 2) / 2);
  });

  test("cancellation ends a pending start notification without starting a worker", async () => {
    const started = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    const fixture = startRunner({
      delivery: "publish",
      options: {
        onRunStart: () => {
          started.resolve();
          return delivery.promise;
        },
      },
    });
    await started.promise;
    fixture.worker.abort();
    expect((await fixture.worker.completion).cancellation).toBe("cancelled");
    expect(fixture.ctx.turns).toEqual([]);
    delivery.resolve();
  });

  test("a stalled start callback cannot outlive the review deadline", async () => {
    const delivery = Promise.withResolvers<void>();
    const fixture = startRunner({
      delivery: "publish",
      options: { reviewTimeoutMs: 25, onRunStart: () => delivery.promise },
    });
    const result = await fixture.worker.completion;
    expect(result.error).toContain("timed out before worker startup");
    expect(result.cancellation).toBeUndefined();
    expect(fixture.ctx.turns).toEqual([]);
    delivery.resolve();
  });

  test("worker startup receives only the time remaining after notification", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const started = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    const fixture = startRunner({
      delivery: "publish",
      options: {
        reviewTimeoutMs: 1_000,
        onRunStart: () => {
          started.resolve();
          return delivery.promise;
        },
      },
    });
    const run = fixture.ctx.sessions.run;
    const budgets: (number | undefined)[] = [];
    fixture.ctx.sessions.run = (key, prompt, options) => {
      budgets.push(options?.timeoutMs);
      return run(key, prompt, options);
    };
    await started.promise;
    vi.setSystemTime(new Date("2026-11-04T12:00:00.400Z"));
    delivery.resolve();
    await fixture.worker.completion;
    expect(budgets).toEqual([600]);
  });

  test("recorded completion survives a later worker execution error", async () => {
    const fixture = startRunner({
      reply: async (ctx) => {
        await submit(
          ctx,
          "github_review_finish",
          completed("github_review_finish", '{"markdown":"Report"}'),
        );
        throw new Error("Worker disconnected after completion");
      },
    });
    const result = await fixture.worker.completion;
    expect(result.submitted?.status).toBe("completed");
    expect(result.error).toContain("disconnected");
    expect(fixture.records[0].report).toEqual({ markdown: "Report" });
  });
});
