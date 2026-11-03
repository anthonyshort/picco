import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Plugin, type PluginContext } from "@picco-agent/core";
import { createReviewControls } from "./controls.js";
import { createGithubSource, GithubReviewSourceError } from "./github.js";
import { createReviewStore, StoreRunSchema, type StoreRun, type QueueItem } from "./store.js";
import { runReview } from "./runner.js";
import { observeWorkflows } from "./workflows.js";
import { GithubReviewsSettingsSchema, type GithubReviewsOptions } from "./types.js";

/**
 * Bound repeated transient failures without retrying remote review writes.
 */
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Poll personal GitHub review requests and dispatch unhandled personal review requests.
 */
export function githubReviews(opts: GithubReviewsOptions): Plugin {
  const {
    github,
    prompt,
    onRunStart,
    onRunComplete,
    validateResult,
    requiresResult,
    secrets = [],
    ...input
  } = opts;
  const settings = GithubReviewsSettingsSchema.parse(input);
  const source = createGithubSource(github);
  const active = new Map<string, ReturnType<typeof runReview>>();
  let ctx: PluginContext | undefined;
  let store: ReturnType<typeof createReviewStore> | undefined;
  let reviewsDirectory: string;
  let reviewer: string | undefined;
  let stopped = true;
  let healthy = false;
  let persistenceFailed = false;
  let failures = 0;
  let nextAllowedAt = 0;
  let backoffUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let dispatching: Promise<void> | undefined;
  let refillRequested = false;
  let controller: AbortController;

  function state() {
    if (!store || !ctx || stopped) throw new Error("GitHub reviews plugin is not started");
    return { store, ctx };
  }

  function manualAdmissionsEnabled() {
    return !stopped && !persistenceFailed && !store!.status().paused;
  }

  function occupied() {
    return active.size;
  }

  function admissionsEnabled() {
    return (
      !stopped &&
      settings.enabled &&
      !persistenceFailed &&
      healthy &&
      Date.now() >= backoffUntil &&
      !store!.status().paused
    );
  }

  function recordFailure(err: unknown) {
    healthy = false;
    failures++;
    const retryAfter = err instanceof GithubReviewSourceError ? (err.retryAfterMs ?? 0) : 0;
    const delay = Math.max(
      retryAfter,
      Math.min(MAX_BACKOFF_MS, settings.pollIntervalMs * 2 ** Math.min(failures, 10)),
    );
    nextAllowedAt = Date.now() + delay;
    backoffUntil = nextAllowedAt;
    const message = redact(err instanceof Error ? err.message : "GitHub polling failed");
    try {
      store!.poll({
        attemptedAt: new Date().toISOString(),
        nextPollAt: new Date(nextAllowedAt).toISOString(),
        error: message,
      });
    } catch {
      persistenceFailed = true;
      controller.abort();
      for (const worker of active.values()) worker.abort("Review state could not be persisted");
      ctx!.logger.error("Review state could not be persisted; admissions stopped");
    }
    ctx!.logger.error("GitHub review discovery/admission failed", { error: message });
  }

  function schedule() {
    if (stopped || !settings.enabled || persistenceFailed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void poll().catch((err) => recordFailure(err));
      },
      Math.max(0, nextAllowedAt - Date.now()),
    );
    timer.unref();
  }

  function poll(): Promise<void> {
    if (polling) return polling;
    if (stopped || !settings.enabled || persistenceFailed) return Promise.resolve();
    if (Date.now() < nextAllowedAt) {
      schedule();
      return Promise.resolve();
    }
    polling = (async () => {
      const attemptedAt = new Date().toISOString();
      try {
        store!.poll({ attemptedAt });
        const found = await source.discover(
          settings.repositories.map((route) => route.name),
          settings.maxPrAgeDays,
          controller.signal,
        );
        if (stopped) return;
        if (reviewer && reviewer.toLowerCase() !== found.reviewer.toLowerCase()) {
          store!.pause(true);
          throw new Error(
            "Authenticated GitHub reviewer changed; paused for operator reconciliation",
          );
        }
        if (!store!.bindReviewer(found.reviewer)) {
          throw new Error(
            "Authenticated GitHub reviewer differs from this database; admissions paused",
          );
        }
        reviewer = found.reviewer.toLowerCase();
        store!.reconcile(reviewer, found.candidates);
        healthy = true;
        failures = 0;
        backoffUntil = found.rateLimit.remaining === 0 ? Date.parse(found.rateLimit.resetAt) : 0;
        nextAllowedAt = Math.max(Date.now() + settings.pollIntervalMs, backoffUntil);
        store!.poll({
          attemptedAt,
          successfulAt: new Date().toISOString(),
          nextPollAt: new Date(nextAllowedAt).toISOString(),
          error: null,
          rateLimit: found.rateLimit,
        });
        await dispatch();
      } catch (err) {
        if (!stopped) recordFailure(err);
      }
    })().finally(() => {
      polling = undefined;
      schedule();
    });
    return polling;
  }

  function dispatch(): Promise<void> {
    if (dispatching) {
      refillRequested = true;
      return dispatching;
    }
    dispatching = (async () => {
      if (!manualAdmissionsEnabled()) return;
      for (const job of store!.jobs.next(1000)) {
        if (!manualAdmissionsEnabled() || occupied() >= settings.maxConcurrentReviews) break;
        let run;
        try {
          const resolved = await source.resolve(job.url, controller.signal);
          if (!manualAdmissionsEnabled()) return;
          store!.jobs.refresh(job.id, resolved.candidate, resolved.base);
          run = store!.jobs.admit(job.id, `review-${randomUUID()}`);
        } catch (err) {
          store!.jobs.block(
            job.id,
            redact(err instanceof Error ? err.message : "Review admission failed"),
          );
          continue;
        }
        if (run) startWorker(run, job.skill);
      }
      if (!admissionsEnabled()) return;
      for (const item of store!.next(1000)) {
        if (!admissionsEnabled() || occupied() >= settings.maxConcurrentReviews) break;
        try {
          await admit(item);
        } catch (err) {
          if (!stopped) recordFailure(err);
          break;
        }
      }
    })().finally(() => {
      dispatching = undefined;
      if (refillRequested && !stopped) {
        refillRequested = false;
        void dispatch().catch((err) => recordFailure(err));
      }
    });
    return dispatching;
  }

  async function admit(item: QueueItem) {
    if (item.reviewer !== reviewer) return;
    const inspection = await source.inspect(item, reviewer, controller.signal);
    if (stopped) return;
    const previousPoll = store!.status().poll;
    if (inspection.rateLimit.remaining === 0) {
      backoffUntil = Math.max(backoffUntil, Date.parse(inspection.rateLimit.resetAt));
      nextAllowedAt = Math.max(nextAllowedAt, backoffUntil);
    }
    store!.poll({
      attemptedAt: previousPoll?.attemptedAt ?? new Date().toISOString(),
      nextPollAt: new Date(nextAllowedAt).toISOString(),
      rateLimit: {
        ...inspection.rateLimit,
        cost: (previousPoll?.rateLimit?.cost ?? 0) + inspection.rateLimit.cost,
      },
    });
    if (!admissionsEnabled()) return;
    if (Date.parse(item.createdAt) < Date.now() - settings.maxPrAgeDays * 86_400_000) {
      store!.supersede(item.id, "outside-creation-window");
      return;
    }
    if (inspection.blockedReason) {
      store!.supersede(item.id, inspection.blockedReason);
      return;
    }
    const { requestEventId, requestedAt } = inspection;
    store!.setCycle(item.id, requestEventId, requestedAt);
    if (store!.hasCompleted(reviewer, item.repository, item.number, requestEventId, requestedAt)) {
      store!.markPreviouslyReviewed(item.id);
      return;
    }
    if (store!.hasAttempted(reviewer, item.repository, item.number, requestEventId, requestedAt)) {
      store!.block(item.id, "prior-attempt-failed");
      return;
    }
    const run = store!.admit(item.id, reviewer, settings.maxConcurrentReviews);
    if (!run) return;
    const route = settings.repositories.find(
      (candidateRoute) => candidateRoute.name === item.repository,
    )!;
    startWorker(run, route.skill);
  }

  function startWorker(admitted: StoreRun, skill: string) {
    const run = StoreRunSchema.parse(admitted);
    const worker = runReview({
      ctx: ctx!,
      store: store!,
      run,
      skill,
      reviewsDirectory,
      timeoutMs: settings.reviewTimeoutMs,
      prompt,
      validateResult,
      requiresResult,
      onRunStart,
      onRunComplete,
    });
    active.set(run.id, worker);
    void worker.completion
      .catch(() => {
        ctx!.logger.error("Review finalisation failed; attempt retained for restart", {
          runId: run.id,
        });
      })
      .finally(() => {
        active.delete(run.id);
        if (!stopped) void dispatch().catch((err) => recordFailure(err));
      });
  }

  const exposedTools = createReviewControls({
    state,
    reviewsDirectory: () => reviewsDirectory,
    settings,
    source,
    active,
    persistenceFailed: () => persistenceFailed,
    signal: () => controller.signal,
    poll: async () => {
      if (timer) clearTimeout(timer);
      nextAllowedAt = Math.max(Date.now(), backoffUntil);
      await poll();
    },
    dispatch,
    redact,
  });

  function redact(value: string) {
    let safe = value;
    for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]");
    return safe
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g,
        "[redacted]",
      )
      .replace(/(Bearer\s+)[^\s"'\\]+/gi, "$1[redacted]")
      .replace(
        /((?:\\*")?(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|authorization|password|client[_-]?secret)(?:\\*")?\s*[:=]\s*\\*")[^"\r\n]*?(?=\\*")/gi,
        "$1[redacted]",
      );
  }

  return {
    name: "github-reviews",
    tools: exposedTools,
    mcpTools: exposedTools,
    prepareExecution: settings.holdWorkflows ? observeWorkflows : undefined,
    async start(context) {
      if (!stopped) throw new Error("GitHub reviews plugin is already started");
      ctx = context;
      reviewsDirectory = path.resolve(settings.reviewsDirectory ?? ctx.filePath());
      store = createReviewStore(path.join(reviewsDirectory, "reviews.sqlite"));
      persistenceFailed = false;
      healthy = false;
      failures = 0;
      refillRequested = false;
      controller = new AbortController();
      stopped = false;
      try {
        store.recoverInterrupted();
        reviewer = store.status().reviewer;
        const previous = store.status().poll;
        nextAllowedAt = previous?.nextPollAt ? Date.parse(previous.nextPollAt) : 0;
        backoffUntil = previous?.error || previous?.rateLimit?.remaining === 0 ? nextAllowedAt : 0;
        schedule();
        await dispatch();
      } catch (err) {
        stopped = true;
        store.close();
        store = undefined;
        throw err;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      for (const worker of active.values()) worker.shutdown();
      await Promise.allSettled([
        ...(polling ? [polling] : []),
        ...(dispatching ? [dispatching] : []),
        ...[...active.values()].map((worker) => worker.completion),
      ]);
      store!.close();
      store = undefined;
    },
  };
}

export { GithubReviewsSettingsSchema, ReviewResultCaptureSchema } from "./types.js";
export type {
  GithubReviewsOptions,
  GithubReviewsSettings,
  GithubReviewResult,
  ReviewSelection,
  ReviewResultCapture,
} from "./types.js";
export type { GithubExecute } from "./github.js";

export { githubFeedback } from "./feedback.js";
export { GithubFeedbackSettingsSchema } from "./feedback-types.js";
export type {
  GithubFeedbackOptions,
  GithubFeedbackSettings,
  FeedbackSelection,
  GithubFeedbackResult,
} from "./feedback-types.js";
