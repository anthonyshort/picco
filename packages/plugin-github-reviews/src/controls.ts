import path from "node:path";
import { readReviewLogs } from "./diagnostics.js";
import { tool, type PluginContext, type Tool, type ToolContext } from "@picco-agent/core";
import { z } from "zod";
import { type createGithubSource } from "./github.js";
import { type createReviewStore } from "./store.js";
import { type runReview } from "./runner.js";
import { type GithubReviewsSettings } from "./types.js";

/**
 * Native review controls share one store and active-worker registry across callers.
 */
export function createReviewControls(opts: {
  state: () => { store: ReturnType<typeof createReviewStore>; ctx: PluginContext };
  settings: GithubReviewsSettings;
  source: ReturnType<typeof createGithubSource>;
  active: Map<string, ReturnType<typeof runReview>>;
  persistenceFailed: () => boolean;
  signal: () => AbortSignal;
  poll: () => Promise<void>;
  dispatch: () => Promise<void>;
  redact: (value: string) => string;
  reviewsDirectory: () => string;
}) {
  const {
    state,
    settings,
    source,
    active,
    persistenceFailed,
    signal,
    poll,
    dispatch,
    redact,
    reviewsDirectory,
  } = opts;
  function assertController(caller: ToolContext["caller"]) {
    if (caller.kind === "session" && caller.ref?.source === "github-reviews")
      throw new Error("Review workers cannot control review jobs");
  }

  function selectedRun(id: string) {
    const current = state().store;
    const manual = current.jobs.find(id);
    const details = manual ?? current.details(id);
    const run =
      details?.runs.find((value) => value.id === id) ??
      (manual ? details?.runs.at(-1) : details?.runs[0]);
    if (!run) throw new Error("Review attempt does not exist");
    return run;
  }

  async function stopRun(id: string) {
    const current = state();
    const manual = current.store.jobs.find(id);
    if (manual?.job.status === "queued" && id === manual.job.id)
      return current.store.jobs.cancelQueued(manual.job.id);
    const run = selectedRun(id);
    const worker = active.get(run.id);
    if (worker) {
      worker.abort("Review cancelled by operator");
      await worker.completion;
    }
    await current.ctx.sessions.reset(run.sessionKey);
    return current.store.jobs.find(id) ?? current.store.details(id);
  }

  async function inspectRun(id: string) {
    const current = state().store;
    const run = selectedRun(id);
    const capture = current.jobs.attempts.result(run.id);
    return {
      run,
      capture,
      partial: !capture?.complete,
      limitation: !capture?.complete
        ? "Only partial or bounded diagnostic output is available; no complete report was saved."
        : undefined,
    };
  }

  const tools: Tool[] = [
    tool({
      name: "github_reviews_start",
      description:
        "Queue a local-only review of one GitHub pull request. Use a stable requestId to safely retry the request. Returns immediately; use details/report to follow it.",
      input: z.object({ url: z.url(), requestId: z.string().trim().min(1).max(200) }).strict(),
      async execute({ url, requestId }, context) {
        assertController(context.caller);
        const current = state();
        if (persistenceFailed()) throw new Error("Review state could not be persisted");
        const previous = current.store.jobs.lookupRequest(requestId, url);
        if (previous) return JSON.stringify(previous);
        const resolved = await source.resolve(url, signal());
        state();
        if (persistenceFailed()) throw new Error("Review state could not be persisted");
        const job = current.store.jobs.submit({
          ...resolved,
          url: resolved.candidate.url,
          requestId,
          source: context.caller.kind === "mcp" ? "mcp" : "tool",
          delivery: "local-only",
          skill:
            settings.repositories.find((route) => route.name === resolved.candidate.repository)
              ?.skill ?? "review",
        });
        await dispatch();
        return JSON.stringify(current.store.jobs.find(job.id)?.job ?? job);
      },
    }),
    tool({
      name: "github_reviews_report",
      description: "Read the full captured review report and bounded diagnostic output.",
      input: z.object({ id: z.uuid() }).strict(),
      async execute({ id }) {
        return JSON.stringify(await inspectRun(id));
      },
    }),
    tool({
      name: "github_reviews_cancel",
      description: "Cancel queued work or stop an active worker. Reports session reset failures.",
      input: z.object({ id: z.uuid() }).strict(),
      async execute({ id }, context) {
        assertController(context.caller);
        return JSON.stringify(await stopRun(id));
      },
    }),
    tool({
      name: "github_reviews_retry",
      description: "Start a fresh attempt for a stopped review, using a stable retry requestId.",
      input: z.object({ id: z.uuid(), requestId: z.string().trim().min(1).max(200) }).strict(),
      async execute({ id, requestId }, context) {
        assertController(context.caller);
        const current = state();
        const manual = current.store.jobs.find(id);
        if (manual) {
          const replay = current.store.jobs.lookupRequest(requestId, manual.job.url);
          if (replay) {
            if (replay.id !== manual.job.id)
              throw new Error("Request ID belongs to a different review job");
            return JSON.stringify(current.store.jobs.find(replay.id));
          }
          if (["queued", "running", "completed"].includes(manual.job.status))
            throw new Error(
              "Cancel active work and confirm teardown before retrying; completed reviews need a new request",
            );
        } else {
          const replay = current.store.retryReceipt(requestId, id);
          if (replay) return JSON.stringify(current.store.details(replay.id));
        }
        const run = manual && manual.runs.length === 0 ? undefined : selectedRun(id);
        if (run) {
          if (run.reviewedAt || run.status === "completed")
            throw new Error("A completed review cannot be retried");
          if (active.has(run.id) || run.status === "running")
            throw new Error("Cancel active work and confirm teardown before retrying");
          await stopRun(run.id);
        }
        if (manual) {
          const resolved = await source.resolve(manual.job.url, signal());
          state();
          current.store.jobs.retry(manual.job.id, {
            candidate: resolved.candidate,
            base: resolved.base,
            requestId,
          });
          await dispatch();
          return JSON.stringify(current.store.jobs.find(manual.job.id));
        }
        if (!run) throw new Error("Review attempt does not exist");
        current.store.retry(run.id, requestId);
        await poll();
        return JSON.stringify(current.store.details(run.id));
      },
    }),
    tool({
      name: "github_reviews_doctor",
      description:
        "Read active workers, queued/running jobs and polling diagnostics without changing state.",
      input: z
        .object({
          id: z.uuid().optional(),
          offset: z.number().int().min(0).max(1000).default(0),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      async execute({ id, offset, limit }) {
        const run = id ? selectedRun(id) : undefined;
        return JSON.stringify({
          run,
          logs: run
            ? await readReviewLogs(path.join(reviewsDirectory(), "runs", run.id), offset, limit)
            : undefined,
          persistenceFailed: persistenceFailed(),
          activeRuns: [...active.keys()],
          explicit: state().store.jobs.list(100),
          automatic: state().store.status(),
        });
      },
    }),
    tool({
      name: "github_reviews_status",
      description:
        "Inspect GitHub review polling, persistent pause/error state and live review workers without starting work.",
      input: z.object({}).strict(),
      async execute() {
        const current = state();
        return JSON.stringify({
          enabled: settings.enabled,
          persistenceFailed: persistenceFailed(),
          activeRuns: [...active.keys()],
          settings,
          ...current.store.status(),
        });
      },
    }),
    tool({
      name: "github_reviews_list",
      description:
        "List recent requested-review candidates and their persisted status without starting reviews.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
      async execute({ limit }) {
        return JSON.stringify(state().store.list(limit));
      },
    }),
    tool({
      name: "github_reviews_jobs",
      description:
        "List recent explicit review jobs alongside polling candidates. Neither starts work.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
      async execute({ limit }) {
        return JSON.stringify({
          automatic: state().store.list(limit),
          explicit: state().store.jobs.list(limit),
        });
      },
    }),
    tool({
      name: "github_reviews_details",
      description: "Inspect a GitHub review item or run, its attempts and completion evidence.",
      input: z.object({ id: z.uuid() }).strict(),
      async execute({ id }) {
        return JSON.stringify(state().store.jobs.find(id) ?? state().store.details(id));
      },
    }),
    tool({
      name: "github_reviews_poll",
      description:
        "Poll requested reviews now, subject to configured enablement, API backoff and admission pause. Never bypasses request-cycle checks.",
      input: z.object({}).strict(),
      async execute(_input, context) {
        assertController(context.caller);
        state();
        await poll();
        return JSON.stringify(state().store.status());
      },
    }),
    tool({
      name: "github_reviews_pause",
      description:
        "Pause new review admissions persistently. Active reviews finish and discovery continues.",
      input: z.object({}).strict(),
      async execute(_input, context) {
        assertController(context.caller);
        state().store.pause(true);
        return "GitHub review admissions paused; active reviews may finish.";
      },
    }),
    tool({
      name: "github_reviews_resume",
      description:
        "Resume paused GitHub review admissions when the user requests it. Configuration disabled and ",
      input: z.object({}).strict(),
      async execute(_input, context) {
        assertController(context.caller);
        state().store.pause(false);
        await poll();
        await dispatch();
        return JSON.stringify(state().store.status());
      },
    }),
  ];

  const exposedTools = tools.map((definition) => ({
    ...definition,
    async execute(input: unknown, context: import("@picco-agent/core").ToolContext) {
      try {
        const result = await definition.execute(input, context);
        return typeof result === "string" ? redact(result) : result;
      } catch (err) {
        throw controlError(err);
      }
    },
  }));

  return exposedTools;

  /**
   * Transport failures may include credentials, so only their sanitised message crosses the
   * boundary.
   */
  function controlError(err: unknown) {
    return new Error(redact(err instanceof Error ? err.message : "Review operation failed"));
  }
}
