import { deliverCallback } from "./callback.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  tool,
  ExecutionError,
  ExecutionFailure,
  type PluginContext,
  type Turn,
} from "@picco-agent/core";
import { z } from "zod";
import { type createReviewStore, type StoreRun } from "./store.js";
import {
  type GithubReviewResult,
  type GithubReviewsOptions,
  type ReviewSelection,
  ReviewResultCaptureSchema,
} from "./types.js";

/**
 * A worker must explicitly declare completion after its review workflow succeeds.
 */
const CompletionSchema = z.object({ summary: z.string().trim().min(1).max(4000) }).strict();

/**
 * Dependencies owned by the review plugin's dispatch lifecycle.
 */
interface RunnerOptions {
  ctx: PluginContext;
  store: ReturnType<typeof createReviewStore>;
  run: StoreRun;
  skill: string;
  reviewsDirectory: string;
  timeoutMs: number;
  prompt?: GithubReviewsOptions["prompt"];
  validateResult?: GithubReviewsOptions["validateResult"];
  requiresResult?: GithubReviewsOptions["requiresResult"];
  onRunStart?: GithubReviewsOptions["onRunStart"];
  onRunComplete?: GithubReviewsOptions["onRunComplete"];
}

/**
 * Start one claimed review and hold its reservation through teardown and recording.
 */
export function runReview(opts: RunnerOptions) {
  let turn: Turn | undefined;
  let abortReason: string | undefined;
  let abandoned = false;
  let settled = false;
  const abort = (reason: string) => {
    abortReason = reason;
    turn?.abort(reason);
  };
  const completion = execute();
  return {
    abort,
    shutdown() {
      if (!settled) abandoned = true;
      abort("GitHub reviews plugin stopped");
    },
    completion,
  };

  async function execute(): Promise<GithubReviewResult> {
    const artifactDirectory = path.join(opts.reviewsDirectory, "runs", opts.run.id);
    const selection: ReviewSelection = {
      run: opts.run,
      skill: opts.skill,
      artifactDirectory,
      publisherStateFile: path.join(artifactDirectory, "progress.json"),
    };
    const declaration = createCompletionDeclaration(opts, selection, () => abortReason);
    const capture = createResultCapture(opts, selection, () => abortReason);
    let output: string | undefined;
    let error: string | undefined;
    try {
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      if (abortReason) throw new Error(abortReason);
      await reportStart(opts, selection);
      if (abortReason) throw new Error(abortReason);
      turn = opts.ctx.sessions.run(
        opts.run.sessionKey,
        opts.prompt?.(selection) ?? buildPrompt(selection),
        {
          timeoutMs: opts.timeoutMs,
          session: {
            cwd: artifactDirectory,
            env: { REVIEW_RUN_ID: opts.run.id },
            tools: [declaration.tool, capture],
          },
        },
      );
      if (abortReason) turn.abort(abortReason);
      output = (await turn).text;
    } catch (err) {
      const cause = err instanceof ExecutionFailure ? err.primary : err;
      if (cause instanceof ExecutionError && cause.code === "shutdown") abandoned = true;
      error = err instanceof Error ? err.message : "Review execution failed";
    } finally {
      settled = true;
      try {
        await opts.ctx.sessions.reset(opts.run.sessionKey);
      } catch (err) {
        error = `Review worker teardown failed: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }
    const summary = declaration.summary();
    const status = summary ? "completed" : error || abortReason ? "interrupted" : "blocked";
    const result: GithubReviewResult = {
      selection,
      status,
      finishedAt: new Date().toISOString(),
      summary,
      output: output?.slice(0, 12_000),
      error: error ?? abortReason,
    };
    opts.store.finish(opts.run.id, {
      status,
      reason: result.error ?? (summary ? undefined : "Review completion was not declared"),
      output: result.output,
      abandoned,
    });
    await reportCompletion(opts, result);
    return result;
  }
}

/**
 * Bind a durable completion declaration to the selected worker session.
 */
function createCompletionDeclaration(
  opts: RunnerOptions,
  selection: ReviewSelection,
  abortReason: () => string | undefined,
) {
  let summary: string | undefined;
  const complete = tool({
    name: "github_review_complete",
    description:
      "Record this selected PR and commit as reviewed only after the entire review skill has finished successfully, including any publication it requires. This records local review completion; it does not post to GitHub. Do not call for a blocked, partial or failed review.",
    input: CompletionSchema,
    async execute(input, ctx) {
      if (
        ctx.caller.kind !== "session" ||
        ctx.caller.ref.source !== "github-reviews" ||
        ctx.caller.ref.key !== opts.run.sessionKey
      ) {
        throw new Error("Only this review's session may record its completion");
      }
      if (abortReason()) throw new Error("Review has been aborted; completion cannot be recorded");
      const checked = CompletionSchema.parse(input);
      const captured = opts.store.jobs.attempts.result(opts.run.id);
      const required = opts.requiresResult?.(selection) ?? Boolean(opts.validateResult);
      if (captured?.complete === false || (required && !captured)) {
        throw new Error("Capture a complete review result before declaring completion");
      }
      if (!opts.store.markReviewed(opts.run.id, checked.summary)) {
        throw new Error("Review reservation expired or was lost; completion was not recorded");
      }
      summary = checked.summary;
      return "Review completion recorded for this PR, commit and request cycle.";
    },
  });
  return { tool: complete, summary: () => summary };
}

/**
 * Retain a full report only from the immutable selected worker session.
 */
function createResultCapture(
  opts: RunnerOptions,
  selection: ReviewSelection,
  abortReason: () => string | undefined,
) {
  return tool({
    name: "github_review_result",
    description:
      "Save this review's full JSON report, including an incomplete report. This does not declare completion or publish anything.",
    input: z
      .object({
        result: z
          .string()
          .min(1)
          .max(4 * 1024 * 1024),
      })
      .strict(),
    async execute({ result }, ctx) {
      if (
        ctx.caller.kind !== "session" ||
        ctx.caller.ref.source !== "github-reviews" ||
        ctx.caller.ref.key !== opts.run.sessionKey
      )
        throw new Error("Only this review's session may save its result");
      if (abortReason()) throw new Error("Review has been aborted");
      const value: unknown = JSON.parse(result);
      const captured = ReviewResultCaptureSchema.parse(
        opts.validateResult
          ? await opts.validateResult(value, selection)
          : { complete: true, value },
      );
      opts.store.jobs.attempts.capture(opts.run.id, captured);
      return captured.complete
        ? "Complete review report saved; declare completion after the workflow succeeds."
        : "Partial review report saved; completion remains blocked.";
    },
  });
}

/**
 * Attempt start reporting without making notification delivery a review prerequisite.
 */
async function reportStart(opts: RunnerOptions, selection: ReviewSelection) {
  if (!opts.onRunStart) return;
  try {
    await deliverCallback(opts.onRunStart, selection);
  } catch {
    opts.ctx.logger.error("review start callback failed; delivery will not be retried", {
      runId: opts.run.id,
    });
  }
}

/**
 * Record one callback attempt after the review outcome is durable.
 */
async function reportCompletion(opts: RunnerOptions, result: GithubReviewResult) {
  if (opts.onRunComplete && opts.store.recordNotificationAttempt(opts.run.id)) {
    try {
      await deliverCallback(opts.onRunComplete, result);
      opts.store.completeNotification(opts.run.id, "confirmed");
    } catch {
      opts.store.completeNotification(
        opts.run.id,
        "uncertain",
        "Completion callback did not confirm delivery",
      );
      opts.ctx.logger.error("review completion callback failed; delivery will not be retried", {
        runId: opts.run.id,
      });
    }
  }
}

/**
 * Bind the shared skill to one already selected PR without a second discovery step.
 */
function buildPrompt(selection: ReviewSelection): string {
  const { run } = selection;
  return [
    `Use the ${selection.skill} skill to review ${run.url}.`,
    `Review exactly commit ${run.head}; the selected reviewer is ${run.reviewer}.`,
    "The server has already selected and reserved this PR. Do not discover or claim another PR.",
    run.delivery === "local-only"
      ? "Run a local-only review. Do not publish comments, reviews or approvals to GitHub."
      : "Follow the skill's research, delegation and publication instructions. Verify the live head before publishing; if it changed, stop and report the blocker.",
    `Keep artifacts in ${selection.artifactDirectory}; use ${selection.publisherStateFile} for publisher state when the skill supports it.`,
    "After the entire workflow succeeds, call github_review_complete once with a concise summary. If blocked or uncertain, do not call it. The host reports the outcome; do not send a separate notification.",
  ].join("\n\n");
}
