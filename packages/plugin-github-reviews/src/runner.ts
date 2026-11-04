import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ExecutionError, ExecutionFailure, type PluginContext, type Turn } from "@picco-agent/core";
import { deliverCallback } from "./callback.js";
import { createReviewFinishTools } from "./review-finish-tools.js";
import { type ReviewAttempt, type ReviewJob, type ReviewFinish } from "./review-types.js";
import type { GithubReviewResult, GithubReviewsOptions, ReviewSelection } from "./types.js";

/**
 * Run one selected worker; persistence remains owned by the reviews service.
 */
interface RunnerOptions {
  ctx: PluginContext;
  job: ReviewJob;
  run: ReviewAttempt;
  reviewsDirectory: string;
  options: GithubReviewsOptions;
  recordOutcome: (outcome: ReviewFinish, report: unknown) => void;
}

/**
 * Execute a fresh session with one atomic final-result submission.
 */
export function runReview(opts: RunnerOptions) {
  let turn: Turn | undefined;
  let cancellation: "cancelled" | "shutdown" | undefined;
  const controller = new AbortController();
  const timeoutMs = opts.options.reviewTimeoutMs ?? 3_600_000;
  const deadline = Date.now() + timeoutMs;
  const startupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const artifactDirectory = path.join(opts.reviewsDirectory, "runs", opts.run.id);
  const selection: ReviewSelection = {
    run: opts.run,
    delivery: opts.job.delivery,
    skill: opts.job.skill,
    artifactDirectory,
    publisherStateFile: path.join(artifactDirectory, "progress.json"),
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
    turn?.abort(reason);
  };
  const completion = executeAttempt();
  return { abort, completion };

  /**
   * Validate one final submission and record it before acknowledging success to the worker.
   */
  async function submitOutcome(input: ReviewFinish) {
    if (cancellation) throw new Error("Review has been cancelled");
    if (submitted) throw new Error("Review outcome already submitted");
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
    return "Review outcome and report recorded.";
  }

  /**
   * Run the selected session within its original deadline and always await session reset.
   */
  async function executeAttempt() {
    let error: string | undefined;
    let output: string | undefined;
    let cleanupError: string | undefined;
    try {
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new ExecutionError("timeout", "Review timed out before worker startup");
      if (opts.job.delivery === "publish" && opts.options.onRunStart) {
        try {
          await deliverCallback(opts.options.onRunStart, selection, startupSignal);
        } catch {
          controller.signal.throwIfAborted();
          if (startupSignal.aborted)
            throw new ExecutionError("timeout", "Review timed out before worker startup");
          opts.ctx.logger.error("Review start notification failed", { runId: opts.run.id });
        }
      }
      if (cancellation) throw new Error("Review cancelled before startup");
      if (Date.now() >= deadline)
        throw new ExecutionError("timeout", "Review timed out before worker startup");
      const prompt =
        opts.options.prompt?.(selection) ??
        [
          `Use the ${opts.job.skill} skill to review ${opts.run.url} at exactly commit ${opts.run.head}, base ${opts.run.base}.`,
          `Keep artifacts in ${artifactDirectory}. Do not discover or select another PR.`,
          opts.job.delivery === "local-only"
            ? "This review is local-only. Do not publish to GitHub or send notifications."
            : "Complete the configured publication and verify the live PR head before publishing. Stop if it changed.",
          "When finished call github_review_finish once, with status, summary and the full result as JSON. Failed or partial work must use status failed with its actual error. A successful launch or final prose is not completion.",
        ].join("\n\n");
      turn = opts.ctx.sessions.run(opts.run.sessionKey, prompt, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        session: {
          cwd: artifactDirectory,
          env: { REVIEW_RUN_ID: opts.run.id },
          tools: createReviewFinishTools(opts.run.sessionKey, submitOutcome),
        },
      });
      output = (await turn).text;
    } catch (err) {
      const primary = err instanceof ExecutionFailure ? err.primary : err;
      if (primary instanceof ExecutionError && primary.code === "shutdown")
        cancellation ??= "shutdown";
      error = err instanceof Error ? err.message : "Review execution failed";
    } finally {
      try {
        await opts.ctx.sessions.reset(opts.run.sessionKey);
      } catch (err) {
        cleanupError = err instanceof Error ? err.message : "Review worker teardown failed";
      }
    }
    return { selection, submitted, report, error, output, cleanupError, cancellation };
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
  output?: string,
): Promise<void> {
  if (selection.delivery !== "publish" || !opts.onRunComplete) return;
  const result: GithubReviewResult = {
    selection,
    status,
    summary,
    finishedAt: new Date().toISOString(),
    error,
    output,
  };
  try {
    await deliverCallback(opts.onRunComplete, result);
  } catch {
    ctx.logger.error("Review completion notification failed", { runId: selection.run.id });
  }
}
