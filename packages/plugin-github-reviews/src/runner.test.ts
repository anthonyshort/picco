import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { silentLogger } from "@picco-agent/core";
import { runReview } from "./runner.js";
import type { ReviewJob, ReviewAttempt, ReviewFinish } from "./review-types.js";
import type { GithubReviewsOptions } from "./types.js";

interface RunnerFixtureOptions {
  options?: Partial<GithubReviewsOptions>;
  delivery?: ReviewJob["delivery"];
}

const directories: string[] = [];

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
  const ctx = { logger: silentLogger() };
  const worker = runReview({
    ctx,
    job,
    run,
    reviewsDirectory: directory,
    options: {
      runReview: async () => ({ status: "completed", summary: "Reviewed" }),
      ...input.options,
    },
    recordOutcome: (outcome, report) => {
      records.push({ outcome, report });
    },
  });
  return { ctx, worker, records };
}

describe("review runner", () => {
  describe("application review runner", () => {
    test.each(["publish", "local-only"] as const)(
      "saves the %s runner's result without a session",
      async (delivery) => {
        const report = { markdown: "Full report".repeat(20_000) };
        const customRunner = vi.fn(
          async (
            selection: Parameters<NonNullable<GithubReviewsOptions["runReview"]>>[0],
            signal: AbortSignal,
          ): Promise<ReviewFinish> => {
            expect(selection.delivery).toBe(delivery);
            expect(selection.run.head).toBe("a".repeat(40));
            expect(signal.aborted).toBe(false);
            return { status: "completed", summary: "Reviewed", result: JSON.stringify(report) };
          },
        );
        const fixture = startRunner({
          delivery,
          options: { runReview: customRunner, resultSchema: z.object({ markdown: z.string() }) },
        });
        const result = await fixture.worker.completion;
        expect(result.submitted?.status).toBe("completed");
        expect(result.report).toEqual(report);
        expect(fixture.records).toHaveLength(1);
        expect(customRunner).toHaveBeenCalledTimes(1);
      },
    );

    test("retains a failed runner's partial report", async () => {
      const fixture = startRunner({
        options: {
          resultSchema: z.object({ markdown: z.string() }),
          runReview: async () => ({
            status: "failed",
            error: "Missing evidence",
            result: '{"inspected":["file.ts"]}',
          }),
        },
      });
      const result = await fixture.worker.completion;
      expect(result.submitted?.status).toBe("failed");
      expect(fixture.records).toEqual([
        {
          outcome: {
            status: "failed",
            error: "Missing evidence",
            result: '{"inspected":["file.ts"]}',
          },
          report: { inspected: ["file.ts"] },
        },
      ]);
    });

    test("rejects an invalid completed outcome without saving it", async () => {
      const fixture = startRunner({
        options: { runReview: async () => ({ status: "completed" }) },
      });
      expect((await fixture.worker.completion).error).toContain(
        "Completed reviews require a summary",
      );
      expect(fixture.records).toEqual([]);
    });

    test("keeps the runner's error without starting a fallback session", async () => {
      const fixture = startRunner({
        options: {
          runReview: async () => {
            throw new Error("Pinned head changed");
          },
        },
      });
      expect((await fixture.worker.completion).error).toBe("Pinned head changed");
      expect(fixture.records).toEqual([]);
    });

    test.each(["cancel", "timeout"] as const)(
      "awaits runner teardown after %s before finishing",
      async (reason) => {
        const started = Promise.withResolvers<AbortSignal>();
        const aborted = Promise.withResolvers<void>();
        const cleanup = Promise.withResolvers<void>();
        const fixture = startRunner({
          options: {
            reviewTimeoutMs: reason === "timeout" ? 50 : 1000,
            runReview: async (selection, signal) => {
              expect(selection.delivery).toBe("local-only");
              started.resolve(signal);
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
              aborted.resolve();
              await cleanup.promise;
              return { status: "completed", summary: "Too late" };
            },
          },
        });
        const signal = await started.promise;
        let settled = false;
        void fixture.worker.completion.then(() => {
          settled = true;
          return undefined;
        });
        if (reason === "cancel") fixture.worker.abort();
        await aborted.promise;
        await setImmediate();
        expect(signal.aborted).toBe(true);
        expect(settled).toBe(false);
        cleanup.resolve();
        const result = await fixture.worker.completion;
        expect(result.error).toBeDefined();
        expect(result.submitted).toBeUndefined();
        expect(fixture.records).toEqual([]);
      },
    );
  });

  test("shutdown does not replace an earlier manual cancellation", async () => {
    const fixture = startRunner();
    fixture.worker.abort();
    fixture.worker.abort(true);
    expect((await fixture.worker.completion).cancellation).toBe("cancelled");
    expect(fixture.records).toEqual([]);
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
    delivery.resolve();
  });

  test.each([undefined, "null", "{", "{}"])(
    "rejects an invalid report %s without saving",
    async (result) => {
      const fixture = startRunner({
        options: {
          resultSchema: z.object({ markdown: z.string() }),
          runReview: async () => ({ status: "completed", summary: "Reviewed", result }),
        },
      });
      expect((await fixture.worker.completion).error).toBeDefined();
      expect(fixture.records).toEqual([]);
    },
  );

  test.each([undefined, null])("rejects a schema that discards the report to %s", async (value) => {
    const fixture = startRunner({
      options: {
        resultSchema: z.unknown().transform(() => value),
        runReview: async () => ({
          status: "completed",
          summary: "Reviewed",
          result: '{"markdown":"Report"}',
        }),
      },
    });
    expect((await fixture.worker.completion).error).toContain("report is required");
    expect(fixture.records).toEqual([]);
  });

  test.each([false, true])(
    "checks the 4 MiB UTF-8 result boundary, oversized=%s",
    async (oversized) => {
      const limit = 4 * 1024 * 1024;
      const result = JSON.stringify("é".repeat((limit - (oversized ? 0 : 2)) / 2));
      const fixture = startRunner({
        options: {
          resultSchema: z.string(),
          runReview: async () => ({ status: "completed", summary: "Reviewed", result }),
        },
      });
      const outcome = await fixture.worker.completion;
      if (oversized) {
        expect(outcome.error).toContain("4 MiB");
        expect(fixture.records).toEqual([]);
      } else {
        expect(outcome.submitted?.status).toBe("completed");
        expect(fixture.records).toHaveLength(1);
        expect(fixture.records[0].report).toHaveLength((limit - 2) / 2);
      }
    },
  );
});
