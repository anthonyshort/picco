import { randomUUID } from "node:crypto";
import path from "node:path";
import { tool, type Plugin, type PluginContext } from "@picco-agent/core";
import { z } from "zod";
import { createGithubSource, GithubReviewSourceError } from "./github.js";
import { createReviewStore, type QueueItem } from "./store.js";
import { runReview } from "./runner.js";
import { GithubReviewsSettingsSchema, type GithubReviewsOptions } from "./types.js";

/**
 * Renew dispatcher ownership before its five-minute lease can expire.
 */
const HEARTBEAT_MS = 60_000;

/**
 * Bound repeated transient failures without retrying remote review writes.
 */
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Poll personal GitHub review requests and dispatch only unreviewed PR heads.
 */
export function githubReviews(opts: GithubReviewsOptions): Plugin {
  const { github, prompt, onRunComplete, ...input } = opts;
  const settings = GithubReviewsSettingsSchema.parse(input);
  const source = createGithubSource(github);
  const owner = randomUUID();
  const active = new Map<string, ReturnType<typeof runReview>>();
  let ctx: PluginContext | undefined;
  let store: ReturnType<typeof createReviewStore> | undefined;
  let reviewsDirectory: string;
  let reviewer: string | undefined;
  let stopped = true;
  let healthy = false;
  let ownershipLost = false;
  let failures = 0;
  let nextAllowedAt = 0;
  let backoffUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let polling: Promise<void> | undefined;
  let dispatching: Promise<void> | undefined;
  let refillRequested = false;
  let controller: AbortController;

  function state() {
    if (!store || !ctx || stopped) throw new Error("GitHub reviews plugin is not started");
    return { store, ctx };
  }

  function admissionsEnabled() {
    return (
      !stopped &&
      settings.enabled &&
      !ownershipLost &&
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
    const message = err instanceof Error ? err.message : "GitHub polling failed";
    try {
      store!.poll({
        attemptedAt: new Date().toISOString(),
        nextPollAt: new Date(nextAllowedAt).toISOString(),
        error: message,
      });
    } catch {
      ownershipLost = true;
      controller.abort();
      for (const worker of active.values()) worker.abort("Review state could not be persisted");
      ctx!.logger.error("Review state could not be persisted; admissions stopped");
    }
    ctx!.logger.error("GitHub review discovery/admission failed", { error: message });
  }

  function schedule() {
    if (stopped || !settings.enabled || ownershipLost) return;
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
    if (stopped || !settings.enabled || ownershipLost) return Promise.resolve();
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
      if (!admissionsEnabled()) return;
      for (const item of store!.next(1000)) {
        if (!admissionsEnabled() || active.size >= settings.maxConcurrentReviews) break;
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
    if (
      store!.hasCompleted(
        reviewer,
        item.repository,
        item.number,
        item.head,
        requestEventId,
        requestedAt,
      )
    ) {
      store!.markPreviouslyReviewed(item.id);
      return;
    }
    if (
      store!.hasAttempted(
        reviewer,
        item.repository,
        item.number,
        item.head,
        requestEventId,
        requestedAt,
      )
    ) {
      store!.block(item.id, "prior-attempt-needs-reconciliation");
      return;
    }
    const run = store!.admit(item.id, reviewer, settings.maxConcurrentReviews);
    if (!run) return;
    const route = settings.repositories.find(
      (candidateRoute) => candidateRoute.name === item.repository,
    )!;
    const worker = runReview({
      ctx: ctx!,
      store: store!,
      run,
      skill: route.skill,
      reviewsDirectory,
      timeoutMs: settings.reviewTimeoutMs,
      prompt,
      onRunComplete,
    });
    active.set(run.id, worker);
    void worker.completion
      .catch(() => {
        ctx!.logger.error("Review finalisation failed; reservation retained for recovery", {
          runId: run.id,
        });
      })
      .finally(() => {
        active.delete(run.id);
        if (!stopped) void dispatch().catch((err) => recordFailure(err));
      });
  }

  const tools = [
    tool({
      name: "github_reviews_status",
      description:
        "Inspect GitHub review polling, persistent pause/error state and live review workers without starting work.",
      input: z.object({}).strict(),
      async execute() {
        const current = state();
        return JSON.stringify({
          enabled: settings.enabled,
          ownershipLost,
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
      name: "github_reviews_details",
      description: "Inspect a GitHub review item or run, its attempts and completion evidence.",
      input: z.object({ id: z.uuid() }).strict(),
      async execute({ id }) {
        return JSON.stringify(state().store.details(id));
      },
    }),
    tool({
      name: "github_reviews_poll",
      description:
        "Poll requested reviews now, subject to configured enablement, API backoff and admission pause. Never bypasses reviewed-head checks.",
      input: z.object({}).strict(),
      async execute() {
        state();
        if (timer) clearTimeout(timer);
        nextAllowedAt = Math.max(Date.now(), backoffUntil);
        await poll();
        return JSON.stringify(state().store.status());
      },
    }),
    tool({
      name: "github_reviews_pause",
      description:
        "Pause new review admissions persistently. Active reviews finish and discovery continues.",
      input: z.object({}).strict(),
      async execute() {
        state().store.pause(true);
        return "GitHub review admissions paused; active reviews may finish.";
      },
    }),
    tool({
      name: "github_reviews_resume",
      description:
        "Resume paused GitHub review admissions when the user requests it. Configuration disabled and uncertain runs still block admissions.",
      input: z.object({}).strict(),
      async execute() {
        state().store.pause(false);
        nextAllowedAt = Math.max(Date.now(), backoffUntil);
        await poll();
        return JSON.stringify(state().store.status());
      },
    }),
    tool({
      name: "github_reviews_resolve",
      description:
        "Resolve an uncertain review only after the user has confirmed its outcome. Mark completed if already reviewed, or retry only after confirming the earlier worker stopped and retrying will not duplicate remote effects. Record the evidence in reason. For completed runs without a saved declaration, supply reviewedAt as the verified original UTC completion timestamp, not the time of resolution.",
      input: z
        .object({
          runId: z.uuid(),
          action: z.enum(["completed", "retry"]),
          reason: z.string().trim().min(1).max(4000),
          reviewedAt: z.iso.datetime().optional(),
        })
        .strict(),
      async execute({ runId, action, reason, reviewedAt }) {
        state().store.resolveInterrupted(runId, action, reason, reviewedAt);
        return "Review resolution recorded. The next poll will revalidate any retry.";
      },
    }),
  ];

  return {
    name: "github-reviews",
    tools,
    async start(context) {
      if (!stopped) throw new Error("GitHub reviews plugin is already started");
      ctx = context;
      reviewsDirectory = path.resolve(settings.reviewsDirectory ?? ctx.filePath());
      store = createReviewStore(path.join(reviewsDirectory, "reviews.sqlite"));
      if (!store.claimDispatcher(owner)) {
        store.close();
        store = undefined;
        throw new Error("Another GitHub review dispatcher owns this database");
      }
      ownershipLost = false;
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
        heartbeat = setInterval(() => {
          try {
            if (store!.renewDispatcher(owner)) return;
          } catch {
            /* Stop admissions on lost dispatcher ownership. */
          }
          ownershipLost = true;
          healthy = false;
          controller.abort();
          for (const worker of active.values()) worker.abort("Review dispatcher ownership lost");
          ctx!.logger.error("Review dispatcher ownership lost; admissions stopped");
        }, HEARTBEAT_MS);
        heartbeat.unref();
        schedule();
      } catch (err) {
        stopped = true;
        store.releaseDispatcher(owner);
        store.close();
        store = undefined;
        throw err;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
      for (const worker of active.values()) worker.abort("GitHub reviews plugin stopped");
      await Promise.allSettled([
        ...(polling ? [polling] : []),
        ...(dispatching ? [dispatching] : []),
        ...[...active.values()].map((worker) => worker.completion),
      ]);
      try {
        store!.releaseDispatcher(owner);
      } finally {
        store!.close();
        store = undefined;
      }
    },
  };
}

export type {
  GithubReviewsOptions,
  GithubReviewsSettings,
  GithubReviewResult,
  ReviewSelection,
} from "./types.js";
export type { GithubExecute } from "./github.js";
