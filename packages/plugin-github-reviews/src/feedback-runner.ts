import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tool, type PluginContext, type Turn } from "@picco-agent/core";
import { deliverCallback } from "./callback.js";
import { type createFeedbackStore } from "./feedback-store.js";
import {
  FeedbackCompletionSchema,
  type FeedbackCompletion,
  type FeedbackRun,
  type FeedbackSelection,
  type GithubFeedbackOptions,
  type GithubFeedbackResult,
} from "./feedback-types.js";

/**
 * Host dependencies for one reserved feedback batch.
 */
interface FeedbackRunnerOptions {
  ctx: PluginContext;
  store: ReturnType<typeof createFeedbackStore>;
  run: FeedbackRun;
  skill: string;
  feedbackDirectory: string;
  timeoutMs: number;
  renewDispatcherLease: () => boolean;
  prompt?: GithubFeedbackOptions["prompt"];
  onRunStart?: GithubFeedbackOptions["onRunStart"];
  onRunComplete?: GithubFeedbackOptions["onRunComplete"];
}

/**
 * Execute one batch already reserved by the store, using a dedicated worker session. Provide
 * durable artifact paths and a session-scoped completion tool; the skill owns edits and GitHub
 * publication. Return an abort handle and a completion promise that resolves after a teardown
 * attempt, outcome persistence and optional callback handling. Persistence failure rejects the
 * promise, leaving the attempt for recovery.
 */
export function runFeedback(opts: FeedbackRunnerOptions) {
  let turn: Turn | undefined;
  let abortReason: string | undefined;
  const abort = (reason: string) => {
    abortReason = reason;
    turn?.abort(reason);
  };
  const artifactDirectory = path.join(
    opts.feedbackDirectory,
    "runs",
    opts.run.resumeRunId ?? opts.run.id,
  );
  const selection: FeedbackSelection = {
    run: opts.run,
    skill: opts.skill,
    artifactDirectory,
    publisherStateFile: path.join(artifactDirectory, "progress.json"),
  };
  const declaration = createCompletionDeclaration(opts, () => abortReason);
  const completion = execute();
  return { abort, completion };

  /**
   * Reuse the original artifact directory for retries, then run the selected skill with only this
   * batch's PR/head/reviews. A normal exit without a completion declaration is blocked; errors or
   * aborts are interrupted. Always attempt session teardown before saving the outcome, and pause
   * admissions if teardown cannot be confirmed.
   */
  async function execute(): Promise<GithubFeedbackResult> {
    let output: string | undefined;
    let error: string | undefined;
    try {
      output = await runWorker();
    } catch (err) {
      error = err instanceof Error ? err.message : "Feedback execution failed";
    } finally {
      try {
        await opts.ctx.sessions.reset(opts.run.sessionKey);
      } catch {
        error = "Feedback worker teardown could not be confirmed";
        opts.store.pause(true);
      }
    }
    const evidence = declaration.evidence();
    const status = error || abortReason ? "interrupted" : evidence ? "completed" : "blocked";
    const result: GithubFeedbackResult = {
      selection,
      status,
      finishedAt: new Date().toISOString(),
      ...evidence,
      output: output?.slice(0, 12_000),
      error: error ?? abortReason,
    };
    opts.store.finish(opts.run.id, { status, output: result.output, error: result.error });
    if (opts.onRunComplete) await report(opts, opts.onRunComplete, result);
    return result;
  }

  /**
   * Prepare artifacts, attempt start reporting and run the selected skill session. Check abort and
   * dispatcher ownership after asynchronous setup; forward aborts to the created turn as well.
   * execute owns teardown and durable outcome recording.
   */
  async function runWorker() {
    await mkdir(selection.artifactDirectory, { recursive: true, mode: 0o700 });
    if (opts.onRunStart) await report(opts, opts.onRunStart, selection);
    if (abortReason || !opts.renewDispatcherLease())
      throw new Error(abortReason ?? "Feedback ownership lost");
    turn = opts.ctx.sessions.run(
      opts.run.sessionKey,
      opts.prompt?.(selection) ?? buildFeedbackPrompt(selection),
      {
        timeoutMs: opts.timeoutMs,
        session: {
          cwd: artifactDirectory,
          env: { FEEDBACK_RUN_ID: opts.run.id },
          tools: [declaration.tool],
        },
      },
    );
    if (abortReason) turn.abort(abortReason);
    return (await turn).text;
  }
}

/**
 * Bind completion evidence to the selected session and persist it before teardown. The declaration
 * reports the skill's result; final handling state is recorded later by execute, and this tool
 * performs no GitHub writes or independent verification.
 */
function createCompletionDeclaration(
  opts: FeedbackRunnerOptions,
  abortReason: () => string | undefined,
) {
  let declaration: FeedbackCompletion | undefined;
  const complete = tool({
    name: "github_feedback_complete",
    description:
      "Record this feedback batch as handled after the entire skill succeeds, including required pushes, summary publication and reactions. Skipped or dismissed feedback counts as handled. Never call for a blocked or uncertain run. This tool does not write to GitHub.",
    input: FeedbackCompletionSchema,
    /**
     * Accept completion evidence only from this run's worker while ownership is valid. Persist the
     * declaration before returning to the worker; final handling state is recorded after teardown
     * is attempted. This tool performs no GitHub writes or verification.
     */
    async execute(input, ctx) {
      if (
        ctx.caller.kind !== "session" ||
        ctx.caller.ref.source !== "github-feedback" ||
        ctx.caller.ref.key !== opts.run.sessionKey
      ) {
        throw new Error("Only this feedback session may declare completion");
      }
      if (abortReason() || !opts.renewDispatcherLease())
        throw new Error("Feedback ownership lost or worker aborted");
      const evidence = FeedbackCompletionSchema.parse(input);
      if (!opts.store.declare(opts.run.id, evidence))
        throw new Error("Feedback attempt is no longer running");
      declaration = evidence;
      return "Feedback completion evidence recorded for the selected reviews.";
    },
  });
  return { tool: complete, evidence: () => declaration };
}

/**
 * Describe the reserved PR/head/review batch and how to invoke its skill safely. Instruct fresh
 * runs to create an isolated checkout and retries to inspect artifacts before repairing remaining
 * work. Require verification of publication and a completion declaration, while later reviews
 * remain assigned to another batch.
 */
function buildFeedbackPrompt(selection: FeedbackSelection): string {
  const { run } = selection;
  return [
    `Use the ${selection.skill} skill to address submitted reviews on ${run.url}, authored by ${run.author}.`,
    `The host selected this batch at head ${run.head}. Do not discover or work on another PR. Selected reviews: ${JSON.stringify(run.reviews)}.`,
    "Read all feedback for context, but apply changes for the selected reviews only. New reviews belong to a later run. Follow repository instructions and the skill's delegation, verification and publication workflow.",
    `Keep artifacts in ${selection.artifactDirectory} and progress state in ${selection.publisherStateFile}. Start the progress helper with --state <that path> --repo ${run.repository} --pr ${run.number} --head ${run.head}.`,
    run.resumeRunId
      ? "This is a resumed attempt. Inspect the preserved checkout, progress state, commits and remote evidence first. Reuse the checkout and original progress comment. If changes were already pushed, repair only missing publication or reactions; use the progress helper sync command for saved publication. Do not repeat fixes or start a fresh checklist."
      : `Create an isolated checkout under the artifact directory from https://github.com/${run.headRepository}.git on the PR head branch ${JSON.stringify(run.headBranch)}. Verify its HEAD equals ${run.head} before editing. Never use an unrelated checkout.`,
    "Before pushing, verify the live PR still points at the starting head and same head repository and branch. If it changed, stop and report the blocker. Push task-only verified commits explicitly to the PR head branch without force.",
    "After the full workflow succeeds, including its final summary and required reactions, call github_feedback_complete with summary and, when applicable, pushedHead and commentUrl. A run with no worthwhile changes still completes after triage and summary. If blocked or uncertain, preserve evidence and do not call completion. The host sends outcome notifications.",
  ].join("\n\n");
}

/**
 * Delivery failures must not repeat code changes or hold a worker slot indefinitely.
 */
async function report<Input>(
  opts: FeedbackRunnerOptions,
  callback: (input: Input) => void | Promise<void>,
  input: Input,
) {
  try {
    await deliverCallback(callback, input);
  } catch {
    opts.ctx.logger.error("Feedback lifecycle callback failed; delivery will not be retried", {
      runId: opts.run.id,
    });
  }
}
