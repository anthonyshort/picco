import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { CandidateSchema, type Candidate } from "./github.js";
import { openReviewDatabase } from "./persistence/database.js";
import { PollingRepository } from "./persistence/polling-repository.js";
import {
  StoreRunSchema,
  OutcomeSchema,
  PollUpdateSchema,
  type StoreRun,
  type ReviewOutcome,
  type PollUpdate,
} from "./persistence/types.js";

/**
 * Maximum time between successful owner renewals.
 */
const LEASE_MS = 5 * 60_000;

/**
 * Coordinate polling lifecycle rules through typed persistence.
 */
export function createReviewStore(filename: string, now = Date.now) {
  const database = openReviewDatabase(filename);
  const repository = new PollingRepository(database);

  function completeResolution(admitted: StoreRun, reason: string, suppliedReviewedAt?: string) {
    const recorded = z.iso.datetime().nullable().parse(repository.reviewedAt(admitted.id));
    const reviewedAt = recorded ?? suppliedReviewedAt;
    if (!reviewedAt)
      throw new Error("Verified original reviewedAt is required to resolve an undeclared review");
    if (
      recorded === null &&
      (Date.parse(reviewedAt) < Math.floor(Date.parse(admitted.startedAt) / 1000) * 1000 ||
        Date.parse(reviewedAt) > now())
    )
      throw new Error("Original reviewedAt must be between the review run's start second and now");
    repository.completeResolution(admitted.id, reviewedAt, reason);
    repository.recordReviewed(admitted, reviewedAt, reason);
    repository.updateQueue(admitted.itemId, "completed", null);
  }

  return {
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
          repository.runningCount() >= z.number().int().min(1).max(100).parse(maxConcurrent) ||
          repository.readState("paused") === true
        )
          return null;
        if (repository.hasClaim(checked.repository, checked.number)) return null;
        const runId = randomUUID();
        const admitted = StoreRunSchema.parse({
          ...checked,
          id: runId,
          itemId: id,
          requestEventId: checked.requestEventId ?? undefined,
          requestedAt: checked.requestedAt ?? undefined,
          startedAt: new Date(now()).toISOString(),
          sessionKey: sessionKey ?? runId,
        });
        repository.insertRun(admitted);
        repository.insertClaim(admitted, now() + LEASE_MS);
        repository.updateQueue(id, "running", null);
        return admitted;
      });
    },
    renew(runId: string) {
      return repository.renewClaim(runId, now() + LEASE_MS, now());
    },
    markReviewed(runId: string, summary: string) {
      const checked = z.string().trim().min(1).max(12_000).parse(summary);
      return repository.transaction(() => {
        if (!repository.declareReviewed(runId, new Date(now()).toISOString(), checked, now()))
          return false;
        const admitted = repository.run(runId)!;
        const reviewedAt = z.iso.datetime().parse(repository.reviewedAt(runId));
        repository.recordReviewed(admitted, reviewedAt, checked);
        return true;
      });
    },
    finish(runId: string, outcome: ReviewOutcome) {
      const checked = OutcomeSchema.parse(outcome);
      repository.transaction(() => {
        const admitted = repository.run(runId);
        if (!admitted) throw new Error("Review run does not exist");
        if (!repository.ownsClaim(runId))
          throw new Error("Review run no longer owns its reservation");
        if (checked.status === "completed" && repository.reviewedAt(runId) === null)
          throw new Error("Cannot complete a review without a reviewed declaration");
        const uncertain =
          checked.status === "interrupted" || checked.reason === "publication-uncertain";
        const reason = uncertain ? "publication-uncertain" : (checked.reason ?? null);
        repository.finishRun(
          runId,
          checked.status,
          new Date(now()).toISOString(),
          reason,
          checked.output?.slice(0, 12_000) ?? null,
        );
        repository.updateQueue(
          admitted.itemId,
          uncertain || checked.status === "blocked" ? "blocked" : "completed",
          reason,
        );
        if (uncertain) repository.markClaimUncertain(runId);
        else repository.removeClaim(runId);
      });
    },
    recoverInterrupted() {
      return repository.transaction(() => {
        const rows = repository.runningRuns();
        for (const checked of rows) {
          repository.interruptRun(checked.id, new Date(now()).toISOString());
          repository.updateQueue(checked.itemId, "blocked", "publication-uncertain");
          repository.markClaimUncertain(checked.id);
        }
        return rows.length;
      });
    },
    resolveInterrupted(
      runId: string,
      action: "completed" | "retry",
      reason: string,
      reviewedAt?: string,
    ) {
      const checked = z
        .object({
          action: z.enum(["completed", "retry"]),
          reason: z.string().trim().min(1).max(6000),
          reviewedAt: z.iso.datetime().optional(),
        })
        .parse({ action, reason, reviewedAt });
      return repository.transaction(() => {
        const admitted = repository.run(runId);
        if (!admitted || !repository.ownsClaim(runId, true))
          throw new Error("Review run has no uncertain reservation to resolve");
        switch (checked.action) {
          case "completed":
            completeResolution(admitted, checked.reason, checked.reviewedAt);
            break;
          case "retry":
            if (repository.reviewedAt(runId) !== null)
              throw new Error(
                "Review completion is already recorded; resolve as completed instead of retrying",
              );
            repository.recordRetryResolution(runId, checked.reason);
            repository.updateQueue(admitted.itemId, "queued", null);
            break;
          default:
            throw new Error("Unknown review resolution");
        }
        repository.removeClaim(runId);
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
      return repository.recordNotificationAttempt(runId);
    },
    completeNotification(
      runId: string,
      status: "confirmed" | "failed" | "uncertain",
      error?: string,
    ) {
      repository.completeNotification(
        runId,
        z.enum(["confirmed", "failed", "uncertain"]).parse(status),
        error?.slice(0, 6000) ?? null,
      );
    },
    claimDispatcher(owner: string) {
      return repository.transaction(() => {
        const previous = repository.readState("dispatcher");
        if (previous) {
          const lease = z.object({ owner: z.string(), expiresAt: z.number() }).parse(previous);
          if (lease.owner !== owner) {
            const identity = z
              .object({ host: z.string(), pid: z.number().int().positive() })
              .safeParse(previous);
            if (!identity.success || identity.data.host !== hostname()) return false;
            try {
              process.kill(identity.data.pid, 0);
              return false;
            } catch (err) {
              if (!z.object({ code: z.literal("ESRCH") }).safeParse(err).success) return false;
            }
          }
        }
        repository.writeState("dispatcher", {
          owner,
          expiresAt: now() + LEASE_MS,
          host: hostname(),
          pid: process.pid,
        });
        return true;
      });
    },
    renewDispatcher(owner: string) {
      return repository.transaction(() => {
        const previous = repository.readState("dispatcher");
        if (!previous) return false;
        const lease = z.object({ owner: z.string(), expiresAt: z.number() }).parse(previous);
        if (lease.owner !== owner || lease.expiresAt <= now()) return false;
        repository.writeState("dispatcher", {
          owner,
          expiresAt: now() + LEASE_MS,
          host: hostname(),
          pid: process.pid,
        });
        return true;
      });
    },
    releaseDispatcher(owner: string) {
      repository.transaction(() => {
        const previous = repository.readState("dispatcher");
        if (previous && z.object({ owner: z.string() }).parse(previous).owner === owner)
          repository.deleteState("dispatcher");
      });
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
