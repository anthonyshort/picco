import { type DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type Candidate } from "../github.js";
import { reviewTransaction } from "./database.js";
import {
  QueueItemSchema,
  StoreRunSchema,
  QUEUE_STATES,
  RUN_STATES,
  type QueueItem,
  type StoreRun,
  type ReviewOutcome,
} from "./types.js";

/**
 * Read and write polling records through typed SQLite operations.
 */
export class PollingRepository {
  constructor(private readonly database: DatabaseSync) {}

  transaction<Result>(operation: () => Result): Result {
    return reviewTransaction(this.database, operation);
  }

  item(id: string): QueueItem | null {
    const row = this.database.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
    return row ? QueueItemSchema.parse(row) : null;
  }

  run(id: string): StoreRun | null {
    const row = this.database.prepare("SELECT data FROM review_runs WHERE id = ?").get(id);
    return row ? StoreRunSchema.parse(JSON.parse(z.string().parse(row.data))) : null;
  }

  readState(key: string): unknown {
    const row = this.database.prepare("SELECT data FROM poller_state WHERE key = ?").get(key);
    return row ? JSON.parse(z.string().parse(row.data)) : null;
  }

  writeState(key: string, data: unknown): void {
    this.database
      .prepare(
        "INSERT INTO poller_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }

  deleteState(key: string): void {
    this.database.prepare("DELETE FROM poller_state WHERE key=?").run(key);
  }

  recordReviewed(run: StoreRun, reviewedAt: string, summary: string): void {
    this.database
      .prepare(`INSERT INTO reviewed_commits(reviewer,repository,number,head,requestEventId,reviewedAt,runId,summary)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reviewer,repository,number,head,requestEventId)
      DO UPDATE SET reviewedAt=excluded.reviewedAt,runId=excluded.runId,summary=excluded.summary`)
      .run(
        run.reviewer,
        run.repository,
        run.number,
        run.head,
        run.requestEventId ?? "",
        reviewedAt,
        run.id,
        summary,
      );
  }

  reviewedAt(id: string): string | null {
    return z
      .object({ reviewedAt: z.string().nullable() })
      .parse(this.database.prepare("SELECT reviewedAt FROM review_runs WHERE id=?").get(id))
      .reviewedAt;
  }

  completeResolution(id: string, reviewedAt: string, reason: string): void {
    this.database
      .prepare(
        "UPDATE review_runs SET state='completed',reviewedAt=?,resolution='completed',resolutionReason=?,reason=NULL WHERE id=?",
      )
      .run(reviewedAt, reason, id);
  }

  candidateId(reviewer: string, candidate: Candidate): string | null {
    const row = this.database
      .prepare(
        "SELECT id FROM review_queue WHERE reviewer=? AND repository=? AND number=? AND head=?",
      )
      .get(reviewer, candidate.repository, candidate.number, candidate.head);
    return row ? z.string().parse(row.id) : null;
  }

  saveCandidate(id: string, reviewer: string, candidate: Candidate, seenAt: number): void {
    this.database
      .prepare(`INSERT INTO review_queue
      (id,reviewer,repository,number,title,url,head,createdAt,status,seenAt)
      VALUES (?,?,?,?,?,?,?,?,'queued',?)
      ON CONFLICT(reviewer,repository,number,head) DO UPDATE SET
        title=excluded.title,url=excluded.url,seenAt=excluded.seenAt,
        status=CASE WHEN review_queue.status='running' OR review_queue.reason='publication-uncertain'
          THEN review_queue.status ELSE 'queued' END,
        reason=CASE WHEN review_queue.reason='publication-uncertain' THEN review_queue.reason ELSE NULL END`)
      .run(
        id,
        reviewer,
        candidate.repository,
        candidate.number,
        candidate.title,
        candidate.url,
        candidate.head,
        candidate.createdAt,
        seenAt,
      );
  }

  replaceableCandidates(reviewer: string): string[] {
    return this.database
      .prepare(
        "SELECT id FROM review_queue WHERE reviewer=? AND status!='running' AND (reason IS NULL OR reason!='publication-uncertain')",
      )
      .all(reviewer)
      .map((row) => z.string().parse(row.id));
  }

  next(limit: number): QueueItem[] {
    return this.database
      .prepare(
        "SELECT * FROM review_queue WHERE status='queued' ORDER BY createdAt,repository,number LIMIT ?",
      )
      .all(limit)
      .map((row) => QueueItemSchema.parse(row));
  }

  setCycle(id: string, requestEventId?: string, requestedAt?: string): void {
    this.database
      .prepare(
        "UPDATE review_queue SET requestEventId=?,requestedAt=? WHERE id=? AND status!='running'",
      )
      .run(requestEventId ?? null, requestedAt ?? null, id);
  }

  updateQueue(id: string, status: QueueItem["status"], reason: string | null): void {
    this.database
      .prepare("UPDATE review_queue SET status=?,reason=? WHERE id=?")
      .run(status, reason, id);
  }

  updateInactiveQueue(id: string, status: QueueItem["status"], reason: string): void {
    this.database
      .prepare("UPDATE review_queue SET status=?,reason=? WHERE id=? AND status!='running'")
      .run(status, reason, id);
  }

  runningCount(): number {
    return z
      .number()
      .parse(
        this.database
          .prepare("SELECT COUNT(*) AS count FROM review_runs WHERE state='running'")
          .get()?.count,
      );
  }

  hasClaim(repository: string, number: number): boolean {
    return !!this.database
      .prepare("SELECT runId FROM review_claims WHERE repository=? AND number=?")
      .get(repository, number);
  }

  ownsClaim(runId: string, uncertain = false): boolean {
    const row = uncertain
      ? this.database
          .prepare("SELECT runId FROM review_claims WHERE runId=? AND uncertain=1")
          .get(runId)
      : this.database.prepare("SELECT runId FROM review_claims WHERE runId=?").get(runId);
    return !!row;
  }

  insertRun(run: StoreRun): void {
    this.database
      .prepare("INSERT INTO review_runs(id,itemId,data,state) VALUES (?,?,?,'running')")
      .run(run.id, run.itemId, JSON.stringify(run));
  }

  insertClaim(run: StoreRun, expiresAt: number): void {
    this.database
      .prepare("INSERT INTO review_claims(repository,number,runId,expiresAt) VALUES (?,?,?,?)")
      .run(run.repository, run.number, run.id, expiresAt);
  }

  renewClaim(runId: string, expiresAt: number, now: number): boolean {
    return (
      this.database
        .prepare(
          "UPDATE review_claims SET expiresAt=? WHERE runId=? AND expiresAt>? AND uncertain=0",
        )
        .run(expiresAt, runId, now).changes === 1
    );
  }

  declareReviewed(runId: string, reviewedAt: string, summary: string, now: number): boolean {
    return (
      this.database
        .prepare(`UPDATE review_runs SET reviewedAt=COALESCE(reviewedAt,?),reviewSummary=?
      WHERE id=? AND state='running' AND EXISTS
        (SELECT 1 FROM review_claims WHERE runId=? AND expiresAt>? AND uncertain=0)`)
        .run(reviewedAt, summary, runId, runId, now).changes === 1
    );
  }

  finishRun(
    runId: string,
    status: ReviewOutcome["status"],
    finishedAt: string,
    reason: string | null,
    output: string | null,
  ): void {
    this.database
      .prepare("UPDATE review_runs SET state=?,finishedAt=?,reason=?,output=? WHERE id=?")
      .run(status, finishedAt, reason, output, runId);
  }

  markClaimUncertain(runId: string): void {
    this.database.prepare("UPDATE review_claims SET uncertain=1 WHERE runId=?").run(runId);
  }

  removeClaim(runId: string): void {
    this.database.prepare("DELETE FROM review_claims WHERE runId=?").run(runId);
  }

  runningRuns() {
    return this.database
      .prepare("SELECT id,itemId FROM review_runs WHERE state='running'")
      .all()
      .map((row) => z.object({ id: z.string(), itemId: z.string() }).parse(row));
  }

  interruptRun(runId: string, finishedAt: string): void {
    this.database
      .prepare(
        "UPDATE review_runs SET state='interrupted',reason='publication-uncertain',finishedAt=? WHERE id=?",
      )
      .run(finishedAt, runId);
  }

  recordRetryResolution(runId: string, reason: string): void {
    this.database
      .prepare("UPDATE review_runs SET resolution='retry',resolutionReason=? WHERE id=?")
      .run(reason, runId);
  }

  reviewedCycles(reviewer: string, repository: string, number: number) {
    return this.database
      .prepare(
        "SELECT requestEventId,reviewedAt FROM reviewed_commits WHERE reviewer=? AND repository=? AND number=?",
      )
      .all(reviewer, repository, number)
      .map((row) =>
        z.object({ requestEventId: z.string(), reviewedAt: z.iso.datetime() }).parse(row),
      );
  }

  failedAttempts(reviewer: string, repository: string, number: number) {
    return this.database
      .prepare(`SELECT data,finishedAt FROM review_runs WHERE state!='running' AND reviewedAt IS NULL AND (resolution IS NULL OR resolution!='retry') AND itemId IN
      (SELECT id FROM review_queue WHERE reviewer=? AND repository=? AND number=?)`)
      .all(reviewer, repository, number)
      .map((row) => {
        const checked = z
          .object({ data: z.string(), finishedAt: z.string().nullable() })
          .parse(row);
        return {
          run: StoreRunSchema.parse(JSON.parse(checked.data)),
          finishedAt: checked.finishedAt,
        };
      });
  }

  recordNotificationAttempt(runId: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE review_runs SET notification='attempted' WHERE id=? AND state!='running' AND notification IS NULL",
        )
        .run(runId).changes === 1
    );
  }

  completeNotification(
    runId: string,
    status: "confirmed" | "failed" | "uncertain",
    error: string | null,
  ): void {
    this.database
      .prepare(
        "UPDATE review_runs SET notification=?,notificationError=? WHERE id=? AND notification='attempted'",
      )
      .run(status, error, runId);
  }

  counts() {
    return this.database
      .prepare("SELECT status,COUNT(*) AS count FROM review_queue GROUP BY status")
      .all()
      .map((row) => z.object({ status: z.enum(QUEUE_STATES), count: z.number() }).parse(row));
  }

  reservations() {
    return this.database
      .prepare(
        "SELECT repository,number,runId,expiresAt,uncertain FROM review_claims ORDER BY repository,number",
      )
      .all()
      .map((row) =>
        z
          .object({
            repository: z.string(),
            number: z.number(),
            runId: z.string(),
            expiresAt: z.number(),
            uncertain: z.number(),
          })
          .parse(row),
      );
  }

  list(limit: number): QueueItem[] {
    return this.database
      .prepare(
        "SELECT * FROM review_queue ORDER BY seenAt DESC,createdAt,repository,number LIMIT ?",
      )
      .all(limit)
      .map((row) => QueueItemSchema.parse(row));
  }

  attempts(itemId: string) {
    return this.database
      .prepare(
        "SELECT data,state,finishedAt,reason,output,notification,notificationError,reviewedAt,reviewSummary,resolution,resolutionReason FROM review_runs WHERE itemId=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(itemId)
      .map((row) => {
        const checked = z
          .object({
            data: z.string(),
            state: z.enum(RUN_STATES),
            finishedAt: z.string().nullable(),
            reason: z.string().nullable(),
            output: z.string().nullable(),
            notification: z.string().nullable(),
            notificationError: z.string().nullable(),
            reviewedAt: z.string().nullable(),
            reviewSummary: z.string().nullable(),
            resolution: z.string().nullable(),
            resolutionReason: z.string().nullable(),
          })
          .parse(row);
        const { data, state, ...outcome } = checked;
        return { ...StoreRunSchema.parse(JSON.parse(data)), status: state, ...outcome };
      });
  }
}
