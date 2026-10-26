import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tool, type PluginContext, type Turn } from "@picco-agent/core";
import { z } from "zod";
import { type createReviewStore, type StoreRun } from "./store.js";
import {
  type GithubReviewResult,
  type GithubReviewsOptions,
  type ReviewSelection,
} from "./types.js";

/**
 * Heartbeats continue until the worker has actually been closed.
 */
const HEARTBEAT_MS = 60_000;

/**
 * Bound application reporting after durable review completion.
 */
const CALLBACK_TIMEOUT_MS = 30_000;

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
  onRunComplete?: GithubReviewsOptions["onRunComplete"];
}

/**
 * Start one claimed review and hold its reservation through teardown and recording.
 */
export function runReview(opts: RunnerOptions) {
  let turn: Turn | undefined;
  let abortReason: string | undefined;
  const abort = (reason: string) => {
    abortReason = reason;
    turn?.abort(reason);
  };
  const completion = execute();
  return { abort, completion };

  async function execute(): Promise<GithubReviewResult> {
    const artifactDirectory = path.join(opts.reviewsDirectory, "runs", opts.run.id);
    const selection: ReviewSelection = {
      run: opts.run,
      skill: opts.skill,
      artifactDirectory,
      publisherStateFile: path.join(artifactDirectory, "progress.json"),
    };
    let summary: string | undefined;
    let output: string | undefined;
    let error: string | undefined;
    let cleanupFailed = false;
    const heartbeat = setInterval(() => {
      try {
        if (!opts.store.renew(opts.run.id)) abort("Review reservation expired or was lost");
      } catch {
        abort("Review reservation could not be renewed");
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      if (abortReason) throw new Error(abortReason);
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
          if (abortReason)
            throw new Error("Review has been aborted; completion cannot be recorded");
          const checked = CompletionSchema.parse(input);
          if (!opts.store.markReviewed(opts.run.id, checked.summary)) {
            throw new Error("Review reservation expired or was lost; completion was not recorded");
          }
          summary = checked.summary;
          return "Review completion recorded for this PR, commit and request cycle.";
        },
      });
      turn = opts.ctx.sessions.run(
        opts.run.sessionKey,
        opts.prompt?.(selection) ?? buildPrompt(selection),
        {
          timeoutMs: opts.timeoutMs,
          session: {
            cwd: artifactDirectory,
            env: { REVIEW_RUN_ID: opts.run.id },
            tools: [complete],
          },
        },
      );
      if (abortReason) turn.abort(abortReason);
      output = (await turn).text;
    } catch (err) {
      error = err instanceof Error ? err.message : "Review execution failed";
    } finally {
      try {
        await opts.ctx.sessions.reset(opts.run.sessionKey);
      } catch {
        cleanupFailed = true;
        error = "Review worker teardown could not be confirmed";
      }
      clearInterval(heartbeat);
    }
    const status =
      error || abortReason || cleanupFailed ? "interrupted" : summary ? "completed" : "blocked";
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
      reason: status === "completed" ? undefined : "publication-uncertain",
      output: result.output,
    });
    if (opts.onRunComplete && opts.store.recordNotificationAttempt(opts.run.id)) {
      try {
        await deliverCompletion(opts.onRunComplete, result);
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
    return result;
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
    "Follow the skill's research, delegation and publication instructions. Verify the live head before publishing; if it changed, stop and report the blocker.",
    `Keep artifacts in ${selection.artifactDirectory}; use ${selection.publisherStateFile} for publisher state when the skill supports it.`,
    "After the entire workflow succeeds, call github_review_complete once with a concise summary. If blocked or uncertain, do not call it. The host reports the outcome; do not send a separate notification.",
  ].join("\n\n");
}

/**
 * A stalled notification must not retain a review worker slot indefinitely.
 */
async function deliverCompletion(
  callback: NonNullable<GithubReviewsOptions["onRunComplete"]>,
  result: GithubReviewResult,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Promise.withResolvers<never>();
  timer = setTimeout(
    () => deadline.reject(new Error("Review completion callback timed out")),
    CALLBACK_TIMEOUT_MS,
  );
  try {
    const delivery = callback(result);
    await Promise.race([delivery, deadline.promise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
