import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ExecutionError, type PluginContext } from "@picco-agent/core";
import { deliverCallback } from "./callback.js";
import {
  ReviewFinishSchema,
  type ReviewAttempt,
  type ReviewJob,
  type ReviewFinish,
} from "./review-types.js";
import type { GithubReviewResult, GithubReviewsOptions, ReviewSelection } from "./types.js";

/**
 * Run one selected worker; persistence remains owned by the reviews service.
 */
interface RunnerOptions {
  ctx: Pick<PluginContext, "logger">;
  job: ReviewJob;
  run: ReviewAttempt;
  reviewsDirectory: string;
  options: GithubReviewsOptions;
  recordOutcome: (outcome: ReviewFinish, report: unknown) => void;
}

/**
 * Run a selected review and save one final outcome.
 */
export function runReview(opts: RunnerOptions) {
  let cancellation: "cancelled" | "shutdown" | undefined;
  const controller = new AbortController();
  const timeoutMs = opts.options.reviewTimeoutMs ?? 3_600_000;
  const deadline = Date.now() + timeoutMs;
  const executionSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const artifactDirectory = path.join(opts.reviewsDirectory, "runs", opts.run.id);
  const selection: ReviewSelection = {
    run: opts.run,
    delivery: opts.job.delivery,
    skill: opts.job.skill,
    artifactDirectory,
  };
  let submitted: ReviewFinish | undefined;
  let report: unknown = null;
  /**
   * Abort startup or active execution while retaining the first cancellation reason.
   */
  const abort = (shutdown = false) => {
    cancellation ??= shutdown ? "shutdown" : "cancelled";
    const reason = cancellation === "shutdown" ? "Review host stopped" : "Review cancelled";
    controller.abort(new ExecutionError(cancellation, reason));
  };
  const completion = executeAttempt();
  return { abort, completion };

  /**
   * Validate and save the returned report with its outcome.
   */
  function submitOutcome(input: ReviewFinish) {
    if (cancellation) throw new Error("Review has been cancelled");
    if (Date.now() >= deadline) throw new ExecutionError("timeout", "Review deadline elapsed");
    let finalReport: unknown = null;
    if (input.result !== undefined) {
      if (Buffer.byteLength(input.result) > 4 * 1024 * 1024)
        throw new Error("Review result exceeds 4 MiB");
      finalReport = JSON.parse(input.result);
    }
    if (input.status === "completed" && opts.options.resultSchema) {
      if (finalReport === null || finalReport === undefined)
        throw new Error("A final review report is required");
      finalReport = opts.options.resultSchema.parse(finalReport);
      if (finalReport === null || finalReport === undefined)
        throw new Error("A final review report is required");
    }
    opts.recordOutcome(input, finalReport);
    report = finalReport;
    submitted = input;
  }

  /**
   * Await the selected runner and its cleanup within the original cancellation boundary.
   */
  async function executeAttempt() {
    let error: string | undefined;
    try {
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new ExecutionError("timeout", "Review timed out before worker startup");
      if (opts.job.delivery === "publish" && opts.options.onRunStart) {
        try {
          await deliverCallback(opts.options.onRunStart, selection, executionSignal);
        } catch {
          controller.signal.throwIfAborted();
          if (executionSignal.aborted)
            throw new ExecutionError("timeout", "Review timed out before worker startup");
          opts.ctx.logger.error("Review start notification failed", { runId: opts.run.id });
        }
      }
      if (cancellation) throw new Error("Review cancelled before startup");
      if (Date.now() >= deadline)
        throw new ExecutionError("timeout", "Review timed out before worker startup");
      const outcome = await opts.options.runReview(selection, executionSignal);
      executionSignal.throwIfAborted();
      submitOutcome(ReviewFinishSchema.parse(outcome));
    } catch (err) {
      error = err instanceof Error ? err.message : "Review execution failed";
    }
    return { selection, submitted, report, error, cancellation };
  }
}

/**
 * Report terminal outcomes without repeating review execution on callback failures.
 */
export async function notifyReview(
  opts: GithubReviewsOptions,
  ctx: PluginContext,
  selection: ReviewSelection,
  status: GithubReviewResult["status"],
  summary?: string,
  error?: string,
): Promise<void> {
  if (selection.delivery !== "publish" || !opts.onRunComplete) return;
  const result: GithubReviewResult = {
    selection,
    status,
    summary,
    finishedAt: new Date().toISOString(),
    error,
  };
  try {
    await deliverCallback(opts.onRunComplete, result);
  } catch {
    ctx.logger.error("Review completion notification failed", { runId: selection.run.id });
  }
}
