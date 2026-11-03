import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CandidateSchema, type Candidate } from "./github.js";
import { JobStore } from "./jobs/store.js";
import { JobRepository } from "./persistence/job-repository.js";
import { openReviewDatabase } from "./persistence/database.js";
import { PollingRepository } from "./persistence/polling-repository.js";
import {
  StoreRunSchema,
  OutcomeSchema,
  PollUpdateSchema,
  type ReviewOutcome,
  type PollUpdate,
} from "./persistence/types.js";

/**
 * Coordinate polling lifecycle rules and explicit jobs through shared persistence.
 */
export function createReviewStore(filename: string, now = Date.now) {
  const database = openReviewDatabase(filename);
  const repository = new PollingRepository(database);
  const jobs = new JobStore(new JobRepository(database), now);

  function retryReceipt(requestId: string, targetId: string) {
    const value = repository.readState(`retry:${requestId}`);
    if (!value) return null;
    const recorded = z.object({ runId: z.string() }).parse(value);
    const admitted = repository.run(recorded.runId);
    if (!admitted || (admitted.id !== targetId && admitted.itemId !== targetId))
      throw new Error("Request ID belongs to a different review attempt");
    return admitted;
  }

  return {
    jobs,
    retryReceipt,
    reconcile(reviewer: string, candidates: Candidate[]) {
      const checked = z.array(CandidateSchema).max(1000).parse(candidates);
      repository.transaction(() => {
        const seen = new Set<string>();
        for (const candidate of checked) {
          const id = repository.candidateId(reviewer, candidate) ?? randomUUID();
          seen.add(id);
          repository.saveCandidate(id, reviewer, candidate, now());
        }
        for (const id of repository.replaceableCandidates(reviewer))
          if (!seen.has(id)) repository.updateQueue(id, "superseded", "no-longer-requested");
      });
    },
    next(limit = 100) {
      return repository.next(z.number().int().min(1).max(1000).parse(limit));
    },
    setCycle(id: string, requestEventId?: string, requestedAt?: string) {
      const cycle = z
        .object({
          requestEventId: z.string().min(1).optional(),
          requestedAt: z.iso.datetime().optional(),
        })
        .parse({ requestEventId, requestedAt });
      repository.setCycle(id, cycle.requestEventId, cycle.requestedAt);
    },
    markPreviouslyReviewed(id: string) {
      repository.updateInactiveQueue(id, "completed", "already-reviewed");
    },
    block(id: string, reason: string) {
      repository.updateInactiveQueue(id, "blocked", reason);
    },
    supersede(id: string, reason: string) {
      repository.updateInactiveQueue(id, "superseded", reason);
    },
    admit(id: string, reviewer: string, maxConcurrent: number, sessionKey?: string) {
      return repository.transaction(() => {
        const checked = repository.item(id);
        if (!checked || checked.status !== "queued" || checked.reviewer !== reviewer) return null;
        if (
          repository.runningCount() + jobs.runningCount() >=
            z.number().int().min(1).max(100).parse(maxConcurrent) ||
          repository.readState("paused") === true
        )
          return null;
        if (repository.hasClaim(checked.repository, checked.number)) return null;
        const runId = randomUUID();
        const admitted = StoreRunSchema.parse({
          ...checked,
          source: "poll",
          delivery: "publish",
          id: runId,
          itemId: id,
          requestEventId: checked.requestEventId ?? undefined,
          requestedAt: checked.requestedAt ?? undefined,
          startedAt: new Date(now()).toISOString(),
          sessionKey: sessionKey ?? runId,
        });
        repository.insertRun(admitted);
        repository.insertClaim(admitted, 0);
        repository.updateQueue(id, "running", null);
        return admitted;
      });
    },
    markReviewed(runId: string, summary: string) {
      if (jobs.find(runId)) return jobs.attempts.markReviewed(runId, summary);
      const checked = z.string().trim().min(1).max(12_000).parse(summary);
      return repository.transaction(() => {
        if (!repository.declareReviewed(runId, new Date(now()).toISOString(), checked))
          return false;
        const admitted = repository.run(runId)!;
        const reviewedAt = z.iso.datetime().parse(repository.reviewedAt(runId));
        repository.recordReviewed(admitted, reviewedAt, checked);
        return true;
      });
    },
    finish(runId: string, outcome: ReviewOutcome) {
      if (jobs.find(runId)) return jobs.attempts.finish(runId, outcome);
      const checked = OutcomeSchema.parse(outcome);
      repository.transaction(() => {
        const admitted = repository.run(runId);
        if (!admitted) throw new Error("Review run does not exist");
        if (!repository.ownsClaim(runId))
          throw new Error("Review run no longer owns its reservation");
        if (checked.status === "completed" && repository.reviewedAt(runId) === null)
          throw new Error("Cannot complete a review without a reviewed declaration");
        const completed = repository.reviewedAt(runId) !== null;
        const status = completed ? "completed" : checked.status;
        const reason =
          checked.abandoned && !completed ? "runtime-restarted" : (checked.reason ?? null);
        repository.finishRun(
          runId,
          status,
          new Date(now()).toISOString(),
          reason,
          checked.output?.slice(0, 12_000) ?? null,
        );
        repository.updateQueue(
          admitted.itemId,
          completed ? "completed" : checked.abandoned ? "queued" : "blocked",
          reason,
        );
        repository.removeClaim(runId);
      });
    },
    recoverInterrupted() {
      jobs.recoverInterrupted();
      return repository.transaction(() => {
        const rows = repository.runningRuns();
        for (const checked of rows) {
          repository.interruptRun(checked.id, new Date(now()).toISOString());
          const completed = repository.reviewedAt(checked.id) !== null;
          repository.updateQueue(checked.itemId, completed ? "completed" : "queued", null);
          repository.removeClaim(checked.id);
        }
        repository.clearClaims();
        repository.deleteState("dispatcher");
        return rows.length;
      });
    },
    retry(runId: string, requestId: string) {
      repository.transaction(() => {
        if (retryReceipt(requestId, runId)) return;
        const run = repository.run(runId);
        if (!run || repository.ownsClaim(runId))
          throw new Error("Stop active work before retrying");
        if (repository.reviewedAt(runId)) throw new Error("A completed review cannot be retried");
        repository.recordRetryResolution(runId, "explicit-retry");
        repository.updateQueue(run.itemId, "queued", null);
        repository.writeState(`retry:${requestId}`, { runId });
      });
    },
    hasCompleted(
      reviewer: string,
      repositoryName: string,
      number: number,
      requestEventId?: string,
      requestedAt?: string,
    ) {
      return repository
        .reviewedCycles(reviewer, repositoryName, number)
        .some(
          (record) =>
            (requestEventId !== undefined && record.requestEventId === requestEventId) ||
            requestedAt === undefined ||
            Date.parse(requestedAt) <= Date.parse(record.reviewedAt),
        );
    },
    hasAttempted(
      reviewer: string,
      repositoryName: string,
      number: number,
      requestEventId?: string,
      requestedAt?: string,
    ) {
      return repository
        .failedAttempts(reviewer, repositoryName, number)
        .some(({ run: previous, finishedAt }) => {
          if (requestEventId !== undefined && previous.requestEventId === requestEventId)
            return true;
          return (
            requestedAt === undefined ||
            finishedAt === null ||
            Date.parse(requestedAt) <= Date.parse(finishedAt)
          );
        });
    },
    recordNotificationAttempt(runId: string) {
      if (jobs.find(runId)) return jobs.attempts.recordNotificationAttempt(runId);
      return repository.recordNotificationAttempt(runId);
    },
    completeNotification(
      runId: string,
      status: "confirmed" | "failed" | "uncertain",
      error?: string,
    ) {
      if (jobs.find(runId)) return jobs.attempts.completeNotification(runId, status, error);
      repository.completeNotification(
        runId,
        z.enum(["confirmed", "failed", "uncertain"]).parse(status),
        error?.slice(0, 6000) ?? null,
      );
    },
    bindReviewer(login: string) {
      const reviewer = z.string().trim().min(1).max(200).parse(login).toLowerCase();
      return repository.transaction(() => {
        const previous = repository.readState("reviewer");
        if (previous !== null && z.string().parse(previous) !== reviewer) {
          repository.writeState("paused", true);
          return false;
        }
        repository.writeState("reviewer", reviewer);
        return true;
      });
    },
    status() {
      return {
        paused: repository.readState("paused") === true,
        reviewer:
          repository.readState("reviewer") === null
            ? undefined
            : z.string().parse(repository.readState("reviewer")),
        poll: repository.readState("poll")
          ? PollUpdateSchema.parse(repository.readState("poll"))
          : null,
        counts: repository.counts(),
        reservations: repository.reservations(),
      };
    },
    list(limit = 20) {
      return repository.list(z.number().int().min(1).max(100).parse(limit));
    },
    details(id: string) {
      const selected = repository.item(id) ?? repository.item(repository.run(id)?.itemId ?? "");
      return selected ? { item: selected, runs: repository.attempts(selected.id) } : null;
    },
    pause(paused: boolean) {
      repository.writeState("paused", paused);
    },
    poll(update: PollUpdate) {
      const previous = repository.readState("poll");
      repository.writeState("poll", {
        ...(previous ? PollUpdateSchema.parse(previous) : {}),
        ...PollUpdateSchema.parse(update),
      });
    },
    close() {
      database.close();
    },
  };
}

export { QueueItemSchema, StoreRunSchema } from "./persistence/types.js";
export type { QueueItem, StoreRun, ReviewOutcome, PollUpdate } from "./persistence/types.js";
