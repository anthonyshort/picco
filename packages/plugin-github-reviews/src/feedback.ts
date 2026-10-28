import { randomUUID } from "node:crypto";
import path from "node:path";
import { tool, type Plugin, type PluginContext } from "@picco-agent/core";
import { z } from "zod";
import { GithubReviewSourceError } from "./github-query.js";
import { createGithubFeedbackSource } from "./feedback-source.js";
import { runFeedback } from "./feedback-runner.js";
import { createFeedbackStore } from "./feedback-store.js";
import { GithubFeedbackSettingsSchema, type GithubFeedbackOptions } from "./feedback-types.js";

/**
 * Renew ownership before the persisted five-minute lease expires.
 */
const HEARTBEAT_MS = 60_000;
/**
 * Bound transient discovery backoff independently of remote side effects.
 */
const MAX_BACKOFF_MS = 3_600_000;

/**
 * Debounce submitted reviews on authored PRs and run one feedback worker at a time.
 */
export function githubFeedback(opts: GithubFeedbackOptions = {}): Plugin {
  const { github, prompt, onRunStart, onRunComplete, ...input } = opts;
  const settings = GithubFeedbackSettingsSchema.parse(input);
  if (settings.maxWaitMs < settings.debounceMs)
    throw new Error("maxWaitMs must be at least debounceMs");
  const source = createGithubFeedbackSource(github);
  const owner = randomUUID();
  let ctx: PluginContext | undefined;
  let store: ReturnType<typeof createFeedbackStore> | undefined;
  let active: ReturnType<typeof runFeedback> | undefined;
  let directory: string;
  let stopped = true;
  let ownershipLost = false;
  let failures = 0;
  let nextAllowedAt = 0;
  let backoffUntil = 0;
  let controller: AbortController;
  let polling: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function state() {
    if (stopped || !store) throw new Error("GitHub feedback plugin is not started");
    return store;
  }

  function ownsDispatcher() {
    if (stopped || ownershipLost || !store) return false;
    try {
      if (store.renewDispatcher(owner)) return true;
    } catch {
      // Losing persistent ownership stops all further admissions.
    }
    ownershipLost = true;
    controller.abort();
    active?.abort("Feedback dispatcher ownership lost");
    ctx!.logger.error("Feedback dispatcher ownership lost; admissions stopped");
    return false;
  }

  function schedule() {
    if (stopped || !settings.enabled || ownershipLost) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void poll();
      },
      Math.max(0, nextAllowedAt - Date.now()),
    );
    timer.unref();
  }

  function poll(): Promise<void> {
    if (polling) return polling;
    if (stopped || !settings.enabled || !ownsDispatcher()) return Promise.resolve();
    if (Date.now() < nextAllowedAt) {
      schedule();
      return Promise.resolve();
    }
    polling = (async () => {
      const attemptedAt = new Date().toISOString();
      try {
        store!.poll({ attemptedAt });
        const found = await source.discover(controller.signal);
        if (!ownsDispatcher()) return;
        if (!store!.bindAuthor(found.author))
          throw new Error("Authenticated GitHub author changed; admissions paused");
        store!.reconcile(found.author, found.candidates);
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
        if (active || store!.status().paused || Date.now() < backoffUntil) return;
        for (const candidate of store!.next(settings.debounceMs, settings.maxWaitMs)) {
          const inspection = await source.inspect(candidate, found.author, controller.signal);
          if (!ownsDispatcher()) return;
          if (inspection.rateLimit.remaining === 0) {
            backoffUntil = Date.parse(inspection.rateLimit.resetAt);
            nextAllowedAt = Math.max(nextAllowedAt, backoffUntil);
            store!.poll({
              nextPollAt: new Date(nextAllowedAt).toISOString(),
              rateLimit: inspection.rateLimit,
            });
            return;
          }
          if (inspection.blockedReason || store!.status().paused) continue;
          // A review submitted during inspection resets the debounce before admission.
          found.candidates = found.candidates.map((item) =>
            item.repository === candidate.repository && item.number === candidate.number
              ? inspection.candidate
              : item,
          );
          store!.reconcile(found.author, found.candidates);
          const run = store!.admit(
            inspection.candidate,
            found.author,
            settings.debounceMs,
            settings.maxWaitMs,
          );
          if (!run) continue;
          const worker = runFeedback({
            ctx: ctx!,
            store: store!,
            run,
            skill: settings.skill,
            feedbackDirectory: directory,
            timeoutMs: settings.feedbackTimeoutMs,
            ownsDispatcher,
            prompt,
            onRunStart,
            onRunComplete,
          });
          active = worker;
          void worker.completion
            .catch(() => {
              ctx!.logger.error(
                "Feedback finalisation failed; attempt retained for reconciliation",
                { runId: run.id },
              );
            })
            .finally(() => {
              active = undefined;
            });
          break;
        }
      } catch (err) {
        if (stopped || ownershipLost) return;
        failures++;
        const retryAfterMs = err instanceof GithubReviewSourceError ? (err.retryAfterMs ?? 0) : 0;
        backoffUntil =
          Date.now() +
          Math.max(
            retryAfterMs,
            Math.min(MAX_BACKOFF_MS, settings.pollIntervalMs * 2 ** Math.min(failures, 10)),
          );
        nextAllowedAt = backoffUntil;
        const error = err instanceof Error ? err.message : "GitHub feedback discovery failed";
        try {
          store!.poll({ attemptedAt, nextPollAt: new Date(nextAllowedAt).toISOString(), error });
        } catch {
          ownershipLost = true;
          controller.abort();
          active?.abort("Feedback state could not be persisted");
        }
        ctx!.logger.error("GitHub feedback discovery/admission failed", { error });
      }
    })().finally(() => {
      polling = undefined;
      schedule();
    });
    return polling;
  }

  const tools = [
    tool({
      name: "github_feedback_status",
      description:
        "Inspect feedback discovery, debounce queues, active attempts and persisted errors without starting work.",
      input: z.object({}).strict(),
      async execute() {
        return JSON.stringify({
          enabled: settings.enabled,
          ownershipLost,
          settings,
          ...state().status(),
        });
      },
    }),
    tool({
      name: "github_feedback_list",
      description: "List recent authored PR feedback queues without starting work.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
      async execute({ limit }) {
        return JSON.stringify(state().list(limit));
      },
    }),
    tool({
      name: "github_feedback_details",
      description: "Read a feedback attempt and its saved completion or recovery evidence.",
      input: z.object({ id: z.uuid() }).strict(),
      async execute({ id }) {
        return JSON.stringify(state().details(id));
      },
    }),
    tool({
      name: "github_feedback_poll",
      description:
        "Discover submitted reviews now, respecting enablement, debounce, pause and API backoff.",
      input: z.object({}).strict(),
      async execute() {
        state();
        nextAllowedAt = Math.max(Date.now(), backoffUntil);
        await poll();
        return JSON.stringify(state().status());
      },
    }),
    tool({
      name: "github_feedback_pause",
      description:
        "Persistently pause new feedback workers; discovery continues and active work may finish.",
      input: z.object({}).strict(),
      async execute() {
        state().pause(true);
        return "Feedback admissions paused.";
      },
    }),
    tool({
      name: "github_feedback_resume",
      description:
        "Resume feedback admissions when requested. Does not bypass debounce, disabled configuration or blocked attempts.",
      input: z.object({}).strict(),
      async execute() {
        state().pause(false);
        nextAllowedAt = Math.max(Date.now(), backoffUntil);
        await poll();
        return JSON.stringify(state().status());
      },
    }),
    tool({
      name: "github_feedback_resolve",
      description:
        "Resolve blocked feedback after confirming the prior worker stopped and inspecting commits and publication. Mark completed if handled, or retry to resume saved artifacts. Record evidence in reason; never blindly repeat remote writes.",
      input: z
        .object({
          runId: z.uuid(),
          action: z.enum(["completed", "retry"]),
          reason: z.string().trim().min(1).max(4000),
        })
        .strict(),
      async execute({ runId, action, reason }) {
        state().resolve(runId, action, reason);
        return "Feedback resolution recorded; any retry is revalidated on the next poll.";
      },
    }),
  ];

  return {
    name: "github-feedback",
    tools,
    async start(context) {
      if (!stopped) throw new Error("GitHub feedback plugin is already started");
      ctx = context;
      directory = path.resolve(settings.feedbackDirectory ?? ctx.filePath());
      store = createFeedbackStore(path.join(directory, "feedback.sqlite"));
      if (!store.claimDispatcher(owner)) {
        store.close();
        store = undefined;
        throw new Error("Another GitHub feedback dispatcher owns this database");
      }
      try {
        store.recoverInterrupted();
        controller = new AbortController();
        stopped = false;
        ownershipLost = false;
        failures = 0;
        const previous = store.status().poll;
        nextAllowedAt = previous?.nextPollAt ? Date.parse(previous.nextPollAt) : 0;
        backoffUntil = previous?.error || previous?.rateLimit?.remaining === 0 ? nextAllowedAt : 0;
        heartbeat = setInterval(ownsDispatcher, HEARTBEAT_MS);
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
      active?.abort("GitHub feedback plugin stopped");
      await Promise.allSettled([
        ...(polling ? [polling] : []),
        ...(active ? [active.completion] : []),
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
