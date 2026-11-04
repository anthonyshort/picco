import { randomUUID } from "node:crypto";
import type { PluginContext } from "@picco-agent/core";
import { createGithubSource, GithubReviewSourceError } from "./github.js";
import type { Inspection } from "./github.js";
import { ReviewRepository } from "./persistence/review-repository.js";
import { runReview, notifyReview } from "./runner.js";
import {
  type ReviewJob,
  type ReviewAttempt,
  type ReviewFinish,
  type PollStatus,
} from "./review-types.js";
import type { GithubReviewsOptions, GithubReviewsSettings } from "./types.js";

/**
 * Hold worker capacity until execution, cleanup and notification have settled.
 */
interface ActiveReview {
  job: ReviewJob;
  worker: ReturnType<typeof runReview>;
  completion: Promise<void>;
}

/**
 * Own accepted reviews and their execution; polling is one submission trigger.
 */
export class Reviews {
  private readonly source;
  private readonly active = new Map<string, ActiveReview>();
  private readonly controller = new AbortController();
  private stopped = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private dispatching: Promise<void> | undefined;
  private refill = false;
  private failures = 0;
  private nextAllowedAt = 0;
  private rateLimitUntil = 0;
  private admissionBackoffUntil = 0;
  private pollStatus: PollStatus = {};
  private reviewer: string | undefined;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly ctx: PluginContext,
    private readonly settings: GithubReviewsSettings,
    private readonly options: GithubReviewsOptions,
    private readonly directory: string,
  ) {
    this.source = createGithubSource(options.github);
  }

  /**
   * Recover unfinished attempts as fresh work, retaining recorded completions and reports.
   */
  start(): void {
    this.repository.transaction(() => {
      for (const job of this.repository.running()) {
        const run = this.repository.attempts(job.id)[0];
        if (run?.status === "completed") {
          this.update(job, "completed");
          continue;
        }
        if (run)
          this.repository.saveAttempt({
            ...run,
            status: "interrupted",
            finishedAt: new Date().toISOString(),
            error: "Review host restarted",
          });
        this.update(job, "queued");
      }
    });
    this.wake();
    this.schedule();
  }

  /**
   * Stop admission, abandon active execution and await cleanup before closing persistence.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    for (const active of this.active.values()) active.worker.abort(true);
    await Promise.allSettled([
      ...(this.polling ? [this.polling] : []),
      ...(this.dispatching ? [this.dispatching] : []),
      ...[...this.active.values()].map((active) => active.completion),
    ]);
  }

  status() {
    return {
      enabled: this.settings.enabled,
      paused: this.paused,
      reviewer: this.reviewer,
      poll: this.pollStatus,
      activeRuns: [...this.active.keys()],
      retryAt:
        this.admissionBackoffUntil > Date.now()
          ? new Date(this.admissionBackoffUntil).toISOString()
          : null,
    };
  }

  list(limit: number) {
    return this.repository.list(limit);
  }

  details(id: string) {
    const job = this.repository.job(id);
    if (!job) throw new Error("Unknown review job");
    return { job, runs: this.repository.attempts(job.id) };
  }

  report(id: string) {
    const details = this.details(id);
    const run = details.runs[0];
    return {
      job: details.job,
      run: run ?? null,
      report: run?.report ?? null,
      partial: run?.status !== "completed",
    };
  }

  /**
   * Abort and await active execution even after an outcome is saved, retaining that outcome.
   */
  async cancel(id: string) {
    const { job } = this.details(id);
    const worker = [...this.active.values()].find((active) => active.job.id === id);
    if (worker) {
      worker.worker.abort();
      await worker.completion;
      const final = this.details(id).runs[0];
      if (final?.cleanupError)
        throw new Error(`Review worker cleanup failed: ${final.cleanupError}`);
    } else if (job.status === "queued") this.update(job, "cancelled");
    else if (job.status === "running") throw new Error("Review worker is unavailable");
    return this.details(id);
  }

  /**
   * Queue an unsuccessful job once; active cleanup and completed outcomes are not restarted.
   */
  retry(id: string) {
    this.ensureStarted();
    const { job } = this.details(id);
    if (job.status === "completed") throw new Error("Completed reviews require a new request ID");
    if ([...this.active.values()].some((active) => active.job.id === id)) return this.details(id);
    if (job.status !== "queued" && job.status !== "running") this.update(job, "queued");
    this.wake();
    return this.details(id);
  }

  /**
   * Pause new execution in this process while active work and discovery continue.
   */
  pause(value: boolean) {
    this.paused = value;
    if (!value) this.wake();
    return this.status();
  }

  /**
   * Discover eligible requests, respecting enablement and known API retry deadlines.
   */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (
      this.stopped ||
      !this.settings.enabled ||
      Date.now() < Math.max(this.nextAllowedAt, this.admissionBackoffUntil)
    )
      return Promise.resolve();
    this.polling = (async () => {
      const attemptedAt = new Date().toISOString();
      this.pollStatus = { ...this.pollStatus, attemptedAt };
      try {
        const found = await this.source.discover(
          this.settings.repositories.map((route) => route.name),
          this.settings.maxPrAgeDays,
          this.controller.signal,
        );
        if (this.stopped) return;
        if (this.reviewer && this.reviewer !== found.reviewer.toLowerCase()) {
          this.paused = true;
          throw new Error("Authenticated GitHub reviewer changed; review admissions paused");
        }
        this.reviewer = found.reviewer.toLowerCase();
        this.rateLimitUntil =
          found.rateLimit.remaining === 0 ? Date.parse(found.rateLimit.resetAt) : 0;
        let rateLimit = found.rateLimit;
        for (const candidate of found.candidates) {
          if (
            this.stopped ||
            Date.now() < Math.max(this.rateLimitUntil, this.admissionBackoffUntil)
          )
            break;
          const inspection = await this.source.inspect(
            candidate,
            this.reviewer,
            this.controller.signal,
          );
          rateLimit = { ...inspection.rateLimit, cost: rateLimit.cost + inspection.rateLimit.cost };
          if (rateLimit.remaining === 0) this.rateLimitUntil = Date.parse(rateLimit.resetAt);
          if (this.stopped) break;
          if (inspection.blockedReason || this.previousCycle(this.reviewer, inspection)) continue;
          const route = this.settings.repositories.find(
            (item) => item.name === candidate.repository,
          )!;
          this.createJob({
            requestKey: null,
            source: "poll",
            repository: candidate.repository,
            number: candidate.number,
            url: candidate.url,
            reviewer: this.reviewer,
            requestEventId: inspection.requestEventId ?? null,
            requestedAt: inspection.requestedAt ?? null,
            skill: route.skill,
            delivery: "publish",
          });
        }
        this.failures = 0;
        this.nextAllowedAt = Math.max(
          Date.now() + this.settings.pollIntervalMs,
          this.rateLimitUntil,
          this.admissionBackoffUntil,
        );
        this.pollStatus = {
          attemptedAt,
          successfulAt: new Date().toISOString(),
          nextPollAt: new Date(this.nextAllowedAt).toISOString(),
          error: Date.now() < this.admissionBackoffUntil ? (this.pollStatus.error ?? null) : null,
          rateLimit,
        };
        this.wake();
      } catch (err) {
        if (!this.stopped) {
          this.failures++;
          const delay = Math.max(
            err instanceof GithubReviewSourceError ? (err.retryAfterMs ?? 0) : 0,
            Math.min(3_600_000, this.settings.pollIntervalMs * 2 ** Math.min(this.failures, 10)),
          );
          this.nextAllowedAt = Date.now() + delay;
          if (err instanceof GithubReviewSourceError && err.retryAfterMs !== undefined)
            this.deferAdmission(err.retryAfterMs, err.message);
          this.pollStatus = {
            ...this.pollStatus,
            nextPollAt: new Date(this.nextAllowedAt).toISOString(),
            error: err instanceof Error ? err.message : "GitHub polling failed",
          };
          this.ctx.logger.error("GitHub review discovery failed", { error: this.pollStatus.error });
        }
      }
    })().finally(() => {
      this.polling = undefined;
      this.schedule();
    });
    return this.polling;
  }

  private previousCycle(reviewer: string, inspection: Inspection, excluding?: string): boolean {
    return this.repository
      .cycles(reviewer, inspection.candidate.repository, inspection.candidate.number)
      .some((job) => {
        if (job.id === excluding) return false;
        if (
          inspection.requestEventId !== undefined &&
          job.requestEventId === inspection.requestEventId
        )
          return true;
        if (inspection.requestedAt === undefined) return true;
        const latest = this.repository.attempts(job.id)[0];
        const handledAt = latest?.finishedAt ?? job.createdAt;
        return Date.parse(inspection.requestedAt) <= Date.parse(handledAt);
      });
  }

  private createJob(
    input: Omit<ReviewJob, "id" | "status" | "createdAt" | "updatedAt" | "error">,
  ): ReviewJob {
    const now = new Date().toISOString();
    const job: ReviewJob = {
      ...input,
      id: randomUUID(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.repository.saveJob(job);
    return job;
  }

  private update(job: ReviewJob, status: ReviewJob["status"], error: string | null = null) {
    this.repository.saveJob({ ...job, status, error, updatedAt: new Date().toISOString() });
  }

  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const next = Math.min(
      this.settings.enabled ? Math.max(this.nextAllowedAt, this.admissionBackoffUntil) : Infinity,
      this.admissionBackoffUntil > now ? this.admissionBackoffUntil : Infinity,
    );
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wake();
        if (this.settings.enabled && Date.now() >= this.nextAllowedAt) void this.poll();
        else this.schedule();
      },
      Math.max(0, next - now),
    );
    this.timer.unref();
  }

  private wake() {
    if (this.stopped) return;
    if (this.dispatching) {
      this.refill = true;
      return;
    }
    this.dispatching = this.dispatch()
      .catch((err) => {
        this.paused = true;
        this.ctx.logger.error("Review scheduling failed; admissions paused", {
          error: err instanceof Error ? err.message : "Unknown scheduling error",
        });
      })
      .finally(() => {
        this.dispatching = undefined;
        if (this.refill && !this.stopped) {
          this.refill = false;
          this.wake();
        }
      });
  }

  private async dispatch() {
    for (const job of this.repository.queued()) {
      if (this.stopped || this.paused || this.active.size >= this.settings.maxConcurrentReviews)
        break;
      if (Date.now() < this.admissionBackoffUntil) break;
      if (
        job.source === "poll" &&
        (!this.settings.enabled ||
          Date.now() < this.rateLimitUntil ||
          !this.settings.repositories.some((route) => route.name === job.repository))
      )
        continue;
      if (
        [...this.active.values()].some(
          (worker) => worker.job.repository === job.repository && worker.job.number === job.number,
        )
      )
        continue;
      try {
        const resolved = await this.source.resolve(
          { repository: job.repository, number: job.number },
          this.controller.signal,
        );
        if (this.stopped || this.paused || Date.now() < this.admissionBackoffUntil) break;
        if (this.repository.job(job.id)?.status !== "queued") continue;
        if (resolved.reviewer !== job.reviewer)
          throw new Error("Authenticated GitHub reviewer changed for this job");
        if (job.source === "poll") {
          if (
            Date.parse(resolved.candidate.createdAt) <
            Date.now() - this.settings.maxPrAgeDays * 86_400_000
          )
            throw new Error("Pull request is outside the configured creation window");
          const inspected = await this.source.inspect(
            resolved.candidate,
            resolved.reviewer,
            this.controller.signal,
          );
          if (inspected.rateLimit.remaining === 0) {
            this.rateLimitUntil = Date.parse(inspected.rateLimit.resetAt);
            this.nextAllowedAt = Math.max(this.nextAllowedAt, this.rateLimitUntil);
            this.schedule();
            continue;
          }
          if (inspected.blockedReason) throw new Error(inspected.blockedReason);
          if (this.previousCycle(job.reviewer, inspected, job.id)) {
            this.update(job, "cancelled", "Review request was already handled by another job");
            continue;
          }
          if (
            job.requestEventId &&
            inspected.requestEventId &&
            job.requestEventId !== inspected.requestEventId
          )
            throw new Error("Review request changed before execution; wait for discovery");
        }
        if (
          this.stopped ||
          this.paused ||
          Date.now() < this.admissionBackoffUntil ||
          this.repository.job(job.id)?.status !== "queued"
        )
          continue;
        const id = randomUUID();
        const run: ReviewAttempt = {
          ...resolved.candidate,
          id,
          itemId: job.id,
          reviewer: job.reviewer,
          base: resolved.base,
          requestEventId: job.requestEventId ?? undefined,
          requestedAt: job.requestedAt ?? undefined,
          attempt: this.repository.attempts(job.id).length + 1,
          sessionKey: `review-${id}`,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          status: "running",
          summary: null,
          error: null,
          cleanupError: null,
          output: null,
          report: null,
        };
        this.repository.transaction(() => {
          this.repository.saveAttempt(run);
          this.update(job, "running");
        });
        const worker = runReview({
          ctx: this.ctx,
          job,
          run,
          reviewsDirectory: this.directory,
          options: this.options,
          record: (outcome, report) => this.record(job, run, outcome, report),
        });
        const completion = this.settle(job, run, worker);
        this.active.set(id, { job, worker, completion });
      } catch (err) {
        if (
          !this.stopped &&
          err instanceof GithubReviewSourceError &&
          err.retryAfterMs !== undefined
        ) {
          this.deferAdmission(err.retryAfterMs, err.message);
          this.ctx.logger.error("GitHub review admission delayed", {
            error: err.message,
            retryAt: new Date(this.admissionBackoffUntil).toISOString(),
          });
          break;
        }
        if (!this.stopped)
          this.update(
            job,
            "failed",
            err instanceof Error ? err.message : "Review admission failed",
          );
      }
    }
  }

  private deferAdmission(retryAfterMs: number, error: string) {
    this.admissionBackoffUntil = Math.max(
      this.admissionBackoffUntil,
      Date.now() + Math.max(1, retryAfterMs),
    );
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.admissionBackoffUntil);
    this.pollStatus = {
      ...this.pollStatus,
      error,
      nextPollAt: new Date(this.nextAllowedAt).toISOString(),
    };
    this.schedule();
  }

  private record(job: ReviewJob, run: ReviewAttempt, outcome: ReviewFinish, report: unknown) {
    this.repository.transaction(() => {
      const current = this.repository.attempts(job.id).find((attempt) => attempt.id === run.id)!;
      this.repository.saveAttempt({
        ...current,
        status: outcome.status,
        summary: outcome.summary ?? null,
        error: outcome.error ?? null,
        report,
        finishedAt: new Date().toISOString(),
      });
      this.update(job, outcome.status, outcome.error ?? null);
    });
  }

  private async settle(job: ReviewJob, run: ReviewAttempt, worker: ReturnType<typeof runReview>) {
    try {
      const result = await worker.completion;
      const current = this.repository.attempts(job.id).find((attempt) => attempt.id === run.id)!;
      if (result.cancellation === "shutdown") this.stopped = true;
      const status =
        result.submitted?.status ??
        (result.cancellation === "shutdown"
          ? "interrupted"
          : result.cancellation === "cancelled"
            ? "cancelled"
            : "failed");
      const error =
        result.submitted?.error ??
        result.error ??
        (result.submitted ? null : "Worker finished without recording a review outcome");
      this.repository.transaction(() => {
        this.repository.saveAttempt({
          ...current,
          status,
          error,
          output: result.output?.slice(0, 12_000) ?? null,
          cleanupError: result.cleanupError ?? null,
          finishedAt: current.finishedAt ?? new Date().toISOString(),
        });
        this.update(job, status === "interrupted" ? "queued" : status, error);
      });
      await notifyReview(
        this.options,
        this.ctx,
        result.selection,
        status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "blocked",
        current.summary ?? undefined,
        error ?? undefined,
        result.output,
      );
      if (result.cleanupError) {
        this.paused = true;
        this.ctx.logger.error("Review worker cleanup failed; admissions paused", {
          runId: run.id,
          error: result.cleanupError,
        });
      }
    } catch (err) {
      this.paused = true;
      this.ctx.logger.error("Review result could not be saved; admissions paused", {
        runId: run.id,
        error: err instanceof Error ? err.message : "Persistence failure",
      });
    } finally {
      this.active.delete(run.id);
      this.wake();
    }
  }

  private ensureStarted() {
    if (this.stopped) throw new Error("GitHub reviews plugin is stopped");
  }
}
