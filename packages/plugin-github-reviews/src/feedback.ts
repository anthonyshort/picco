import { randomUUID } from "node:crypto";
import path from "node:path";
import { tool, type Plugin, type PluginContext } from "@picco-agent/core";
import { z } from "zod";
import { GithubReviewSourceError } from "./github-query.js";
import { createGithubFeedbackSource, type FeedbackCandidate } from "./feedback-source.js";
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
 * Coordinate automatic feedback work independently of requested-review automation. Poll GitHub,
 * reconcile observations into SQLite, then reinspect ready PRs and admit one fixed review batch at
 * a time. The runner manages the worker; the selected skill owns triage, code changes and
 * publication. Construction alone does not start polling.
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

  /**
   * Keep this process's exclusive database lease alive. If renewal fails, stop new admissions and
   * abort discovery and the active worker; uncertain work stays persisted for recovery rather than
   * being started again by this process.
   */
  function renewDispatcherLease() {
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

  /**
   * Arm the next poll at the current polling/backoff deadline when enabled and owned. The deadline
   * governs discovery; each PR's debounce is checked separately in the store.
   */
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

  /**
   * Run at most one discovery/admission pass concurrently, respecting API backoff. Persist
   * discovered PR/review observations even while paused or a worker is active. When idle, reinspect
   * ready PRs, reconcile newly observed reviews to recalculate debounce, and atomically admit one
   * batch before starting its worker. Worker completion runs separately. Ordinary discovery
   * failures record backoff; lost ownership or failed error-state persistence stops further
   * scheduling.
   */
  function poll(): Promise<void> {
    if (polling) return polling;
    if (stopped || !settings.enabled || !renewDispatcherLease()) return Promise.resolve();
    if (Date.now() < nextAllowedAt) {
      schedule();
      return Promise.resolve();
    }
    polling = (async () => {
      const attemptedAt = new Date().toISOString();
      try {
        const author = await discoverAndReconcile(attemptedAt);
        if (
          !author ||
          stopped ||
          ownershipLost ||
          active ||
          store!.status().paused ||
          Date.now() < backoffUntil
        )
          return;
        await startNextWorker(author);
      } catch (err) {
        handlePollFailure(err, attemptedAt);
      }
    })().finally(() => {
      polling = undefined;
      schedule();
    });
    return polling;
  }

  /**
   * Persist backoff for an ordinary poll failure without losing queued work. If even error-state
   * persistence fails, abort active work and stop scheduling; an already stopped dispatcher leaves
   * recovery to the next owner.
   */
  function handlePollFailure(err: unknown, attemptedAt: string) {
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

  /**
   * Record one successful discovery and update the persisted queue and polling deadline.
   * Reconciliation owns account binding; repeated scans retain review handling history. Return no
   * account if ownership is lost while GitHub is being read.
   */
  async function discoverAndReconcile(attemptedAt: string) {
    store!.poll({ attemptedAt });
    const found = await source.discover(controller.signal);
    if (!renewDispatcherLease()) return;
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
    return found.author;
  }

  /**
   * Reinspect ready PRs in queue order and start the first batch still eligible. Refresh only the
   * inspected PR before admission so newly observed reviews reset its quiet period. Keep
   * reservation and worker registration synchronous after refresh.
   */
  async function startNextWorker(author: string) {
    for (const candidate of store!.next(settings.debounceMs, settings.maxWaitMs)) {
      const inspection = await source.inspect(candidate, author, controller.signal);
      if (!renewDispatcherLease()) return;
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
      store!.refresh(author, inspection.candidate);
      if (startWorker(inspection.candidate, author)) return;
    }
  }

  /**
   * Reserve and register one worker without yielding between those operations. Admission rechecks
   * debounce, pause and the single-worker slot. The slot stays occupied through teardown attempts,
   * outcome recording and callback handling, including callback failures and timeouts.
   */
  function startWorker(candidate: FeedbackCandidate, author: string) {
    const run = store!.admit(candidate, author, settings.debounceMs, settings.maxWaitMs);
    if (!run) return false;
    const worker = runFeedback({
      ctx: ctx!,
      store: store!,
      run,
      skill: settings.skill,
      feedbackDirectory: directory,
      timeoutMs: settings.feedbackTimeoutMs,
      renewDispatcherLease,
      prompt,
      onRunStart,
      onRunComplete,
    });
    active = worker;
    void worker.completion
      .catch(() => {
        ctx!.logger.error("Feedback finalisation failed; attempt retained for reconciliation", {
          runId: run.id,
        });
      })
      .finally(() => {
        active = undefined;
      });
    return true;
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
    /**
     * Open persistent state, claim exclusive dispatcher ownership and block interrupted attempts
     * before scheduling discovery. Restore saved backoff and renew the lease on a heartbeat.
     * Polling starts only when enabled; failed setup attempts cleanup while preserving the original
     * error if cleanup also fails.
     */
    async start(context) {
      if (!stopped) throw new Error("GitHub feedback plugin is already started");
      ctx = context;
      directory = path.resolve(settings.feedbackDirectory ?? ctx.filePath());
      store = createFeedbackStore(path.join(directory, "feedback.sqlite"));
      let claimed = false;
      try {
        claimed = store.claimDispatcher(owner);
        if (!claimed) throw new Error("Another GitHub feedback dispatcher owns this database");
        store.recoverInterrupted();
        controller = new AbortController();
        stopped = false;
        ownershipLost = false;
        failures = 0;
        const previous = store.status().poll;
        nextAllowedAt = previous?.nextPollAt ? Date.parse(previous.nextPollAt) : 0;
        backoffUntil = previous?.error || previous?.rateLimit?.remaining === 0 ? nextAllowedAt : 0;
        heartbeat = setInterval(renewDispatcherLease, HEARTBEAT_MS);
        heartbeat.unref();
        schedule();
      } catch (err) {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        try {
          if (claimed) store.releaseDispatcher(owner);
        } catch {
          ctx.logger.error("Feedback startup lease cleanup failed");
        }
        try {
          store.close();
        } catch {
          ctx.logger.error("Feedback startup database cleanup failed");
        }
        store = undefined;
        throw err;
      }
    },
    /**
     * Stop timers and abort discovery and the worker, then wait for both to settle before releasing
     * ownership and closing SQLite. The runner attempts to record an interrupted outcome; any
     * still-running row is blocked by recovery at next startup.
     */
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
