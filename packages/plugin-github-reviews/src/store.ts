import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CandidateSchema, type Candidate } from "./github.js";

/**
 * Maximum time between successful owner renewals.
 */
const LEASE_MS = 5 * 60_000;

/**
 * Persisted queue lifecycle states.
 */
const QUEUE_STATES = ["queued", "running", "completed", "blocked", "superseded"] as const;

/**
 * Persisted execution outcomes.
 */
const RUN_STATES = ["running", "completed", "blocked", "interrupted"] as const;

/**
 * Current candidate state with refreshed request-cycle evidence.
 */
export const QueueItemSchema = CandidateSchema.extend({
  id: z.string(),
  reviewer: z.string(),
  status: z.enum(QUEUE_STATES),
  reason: z.string().nullable(),
  requestEventId: z.string().min(1).nullable(),
  requestedAt: z.iso.datetime().nullable(),
  seenAt: z.number().int(),
});

/**
 * Immutable review admission identity and its durable execution outcome.
 */
export const StoreRunSchema = CandidateSchema.extend({
  id: z.string(),
  itemId: z.string(),
  reviewer: z.string(),
  requestEventId: z.string().min(1).optional(),
  requestedAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime(),
  sessionKey: z.string(),
});

/**
 * Durable run completion supplied after worker teardown.
 */
const OutcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "interrupted"]),
  reason: z.string().optional(),
  output: z.string().optional(),
});

/**
 * Recorded result of a polling attempt.
 */
const PollUpdateSchema = z.object({
  attemptedAt: z.iso.datetime(),
  successfulAt: z.iso.datetime().optional(),
  nextPollAt: z.iso.datetime().optional(),
  error: z.string().nullable().optional(),
  rateLimit: z
    .object({ cost: z.number(), remaining: z.number(), resetAt: z.iso.datetime() })
    .optional(),
});

/**
 * One candidate currently observed for the authenticated reviewer.
 */
export type QueueItem = z.infer<typeof QueueItemSchema>;

/**
 * Immutable identity of an admitted review attempt.
 */
export type StoreRun = z.infer<typeof StoreRunSchema>;

/**
 * Durable outcome supplied after worker teardown.
 */
export type ReviewOutcome = z.infer<typeof OutcomeSchema>;

/**
 * Poll result persisted for status after restart.
 */
export type PollUpdate = z.infer<typeof PollUpdateSchema>;

/**
 * Persist review observations, claims, attempts and reviewed declarations in one database.
 */
export function createReviewStore(filename: string, now = Date.now) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (existing) {
    const versions = database.prepare("SELECT version FROM schema_migrations").all();
    if (
      versions.length !== 1 ||
      !z.object({ version: z.literal(1) }).safeParse(versions[0]).success
    ) {
      database.close();
      throw new Error("Unsupported review database schema; admissions stopped");
    }
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY, reviewer TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, head TEXT NOT NULL, createdAt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','superseded')),
      reason TEXT, requestEventId TEXT, requestedAt TEXT, seenAt INTEGER NOT NULL,
      UNIQUE(reviewer,repository,number,head)
    );
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES review_queue(id), data TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','completed','blocked','interrupted')),
      finishedAt TEXT, reason TEXT, output TEXT, notification TEXT, notificationError TEXT,
      reviewedAt TEXT, reviewSummary TEXT, resolution TEXT, resolutionReason TEXT
    );
    CREATE TABLE IF NOT EXISTS review_claims (
      repository TEXT NOT NULL, number INTEGER NOT NULL, runId TEXT NOT NULL UNIQUE REFERENCES review_runs(id),
      expiresAt INTEGER NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(repository,number)
    );
    CREATE TABLE IF NOT EXISTS reviewed_commits (
      reviewer TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL,
      requestEventId TEXT NOT NULL DEFAULT '', reviewedAt TEXT NOT NULL,
      runId TEXT REFERENCES review_runs(id), summary TEXT,
      PRIMARY KEY(reviewer,repository,number,head,requestEventId)
    );
    CREATE TABLE IF NOT EXISTS poller_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS queue_order ON review_queue(status,createdAt,repository,number);
    INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
  `);

  function transaction<Result>(operation: () => Result): Result {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  }

  function item(id: string) {
    const row = database.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
    return row ? QueueItemSchema.parse(row) : null;
  }

  function run(id: string) {
    const row = database.prepare("SELECT data FROM review_runs WHERE id = ?").get(id);
    return row
      ? StoreRunSchema.parse(JSON.parse(z.object({ data: z.string() }).parse(row).data))
      : null;
  }

  function readState(key: string): unknown {
    const row = database.prepare("SELECT data FROM poller_state WHERE key = ?").get(key);
    return row ? JSON.parse(z.object({ data: z.string() }).parse(row).data) : null;
  }

  function writeState(key: string, data: unknown) {
    database
      .prepare(
        "INSERT INTO poller_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }

  function recordReviewed(admitted: StoreRun, reviewedAt: string, summary: string) {
    database
      .prepare(`INSERT INTO reviewed_commits(reviewer,repository,number,head,requestEventId,reviewedAt,runId,summary)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reviewer,repository,number,head,requestEventId)
      DO UPDATE SET reviewedAt=excluded.reviewedAt,runId=excluded.runId,summary=excluded.summary`)
      .run(
        admitted.reviewer,
        admitted.repository,
        admitted.number,
        admitted.head,
        admitted.requestEventId ?? "",
        reviewedAt,
        admitted.id,
        summary,
      );
  }

  function completeResolution(admitted: StoreRun, reason: string, suppliedReviewedAt?: string) {
    const recorded = z
      .object({ reviewedAt: z.iso.datetime().nullable() })
      .parse(database.prepare("SELECT reviewedAt FROM review_runs WHERE id=?").get(admitted.id));
    const reviewedAt = recorded.reviewedAt ?? suppliedReviewedAt;
    if (!reviewedAt) {
      throw new Error("Verified original reviewedAt is required to resolve an undeclared review");
    }
    if (
      recorded.reviewedAt === null &&
      (Date.parse(reviewedAt) < Math.floor(Date.parse(admitted.startedAt) / 1000) * 1000 ||
        Date.parse(reviewedAt) > now())
    ) {
      throw new Error("Original reviewedAt must be between the review run's start second and now");
    }
    database
      .prepare(
        "UPDATE review_runs SET state='completed',reviewedAt=?,resolution='completed',resolutionReason=?,reason=NULL WHERE id=?",
      )
      .run(reviewedAt, reason, admitted.id);
    recordReviewed(admitted, reviewedAt, reason);
    database
      .prepare("UPDATE review_queue SET status='completed',reason=NULL WHERE id=?")
      .run(admitted.itemId);
  }

  return {
    reconcile(reviewer: string, candidates: Candidate[]) {
      const checked = z.array(CandidateSchema).max(1000).parse(candidates);
      transaction(() => {
        const seen = new Set<string>();
        for (const candidate of checked) {
          const previous = database
            .prepare(
              "SELECT id FROM review_queue WHERE reviewer=? AND repository=? AND number=? AND head=?",
            )
            .get(reviewer, candidate.repository, candidate.number, candidate.head);
          const id = previous ? z.object({ id: z.string() }).parse(previous).id : randomUUID();
          seen.add(id);
          database
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
              now(),
            );
        }
        for (const row of database
          .prepare(
            "SELECT id FROM review_queue WHERE reviewer=? AND status!='running' AND (reason IS NULL OR reason!='publication-uncertain')",
          )
          .all(reviewer)) {
          const { id } = z.object({ id: z.string() }).parse(row);
          if (!seen.has(id))
            database
              .prepare(
                "UPDATE review_queue SET status='superseded',reason='no-longer-requested' WHERE id=?",
              )
              .run(id);
        }
      });
    },
    next(limit = 100) {
      return database
        .prepare(
          "SELECT * FROM review_queue WHERE status='queued' ORDER BY createdAt,repository,number LIMIT ?",
        )
        .all(z.number().int().min(1).max(1000).parse(limit))
        .map((row) => QueueItemSchema.parse(row));
    },
    setCycle(id: string, requestEventId?: string, requestedAt?: string) {
      const cycle = z
        .object({
          requestEventId: z.string().min(1).optional(),
          requestedAt: z.iso.datetime().optional(),
        })
        .parse({ requestEventId, requestedAt });
      database
        .prepare(
          "UPDATE review_queue SET requestEventId=?,requestedAt=? WHERE id=? AND status!='running'",
        )
        .run(cycle.requestEventId ?? null, cycle.requestedAt ?? null, id);
    },
    markPreviouslyReviewed(id: string) {
      database
        .prepare(
          "UPDATE review_queue SET status='completed',reason='already-reviewed' WHERE id=? AND status!='running'",
        )
        .run(id);
    },
    block(id: string, reason: string) {
      database
        .prepare(
          "UPDATE review_queue SET status='blocked',reason=? WHERE id=? AND status!='running'",
        )
        .run(reason, id);
    },
    supersede(id: string, reason: string) {
      database
        .prepare(
          "UPDATE review_queue SET status='superseded',reason=? WHERE id=? AND status!='running'",
        )
        .run(reason, id);
    },
    admit(id: string, reviewer: string, maxConcurrent: number, sessionKey?: string) {
      return transaction(() => {
        const checked = item(id);
        if (!checked || checked.status !== "queued" || checked.reviewer !== reviewer) return null;
        const { count } = z
          .object({ count: z.number() })
          .parse(
            database
              .prepare("SELECT COUNT(*) AS count FROM review_runs WHERE state='running'")
              .get(),
          );
        if (
          count >= z.number().int().min(1).max(100).parse(maxConcurrent) ||
          readState("paused") === true
        )
          return null;
        if (
          database
            .prepare("SELECT runId FROM review_claims WHERE repository=? AND number=?")
            .get(checked.repository, checked.number)
        )
          return null;
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
        database
          .prepare("INSERT INTO review_runs(id,itemId,data,state) VALUES (?,?,?,'running')")
          .run(runId, id, JSON.stringify(admitted));
        database
          .prepare("INSERT INTO review_claims(repository,number,runId,expiresAt) VALUES (?,?,?,?)")
          .run(checked.repository, checked.number, runId, now() + LEASE_MS);
        database.prepare("UPDATE review_queue SET status='running',reason=NULL WHERE id=?").run(id);
        return admitted;
      });
    },
    renew(runId: string) {
      return (
        database
          .prepare(
            "UPDATE review_claims SET expiresAt=? WHERE runId=? AND expiresAt>? AND uncertain=0",
          )
          .run(now() + LEASE_MS, runId, now()).changes === 1
      );
    },
    markReviewed(runId: string, summary: string) {
      const checked = z.string().trim().min(1).max(12_000).parse(summary);
      return transaction(() => {
        const changes = database
          .prepare(`UPDATE review_runs SET reviewedAt=COALESCE(reviewedAt,?),reviewSummary=?
        WHERE id=? AND state='running' AND EXISTS
          (SELECT 1 FROM review_claims WHERE runId=? AND expiresAt>? AND uncertain=0)`)
          .run(new Date(now()).toISOString(), checked, runId, runId, now()).changes;
        if (changes !== 1) return false;
        const admitted = run(runId)!;
        const { reviewedAt } = z
          .object({ reviewedAt: z.iso.datetime() })
          .parse(database.prepare("SELECT reviewedAt FROM review_runs WHERE id=?").get(runId));
        recordReviewed(admitted, reviewedAt, checked);
        return true;
      });
    },
    finish(runId: string, outcome: ReviewOutcome) {
      const checked = OutcomeSchema.parse(outcome);
      transaction(() => {
        const admitted = run(runId);
        if (!admitted) throw new Error("Review run does not exist");
        const claim = database.prepare("SELECT runId FROM review_claims WHERE runId=?").get(runId);
        if (!claim) throw new Error("Review run no longer owns its reservation");
        const declaration = z
          .object({ reviewedAt: z.string().nullable() })
          .parse(database.prepare("SELECT reviewedAt FROM review_runs WHERE id=?").get(runId));
        if (checked.status === "completed" && declaration.reviewedAt === null) {
          throw new Error("Cannot complete a review without a reviewed declaration");
        }
        const uncertain =
          checked.status === "interrupted" || checked.reason === "publication-uncertain";
        const reason = uncertain ? "publication-uncertain" : (checked.reason ?? null);
        database
          .prepare("UPDATE review_runs SET state=?,finishedAt=?,reason=?,output=? WHERE id=?")
          .run(
            checked.status,
            new Date(now()).toISOString(),
            reason,
            checked.output?.slice(0, 12_000) ?? null,
            runId,
          );
        database
          .prepare("UPDATE review_queue SET status=?,reason=? WHERE id=?")
          .run(
            uncertain || checked.status === "blocked" ? "blocked" : "completed",
            reason,
            admitted.itemId,
          );
        if (uncertain)
          database.prepare("UPDATE review_claims SET uncertain=1 WHERE runId=?").run(runId);
        else database.prepare("DELETE FROM review_claims WHERE runId=?").run(runId);
      });
    },
    recoverInterrupted() {
      return transaction(() => {
        const rows = database
          .prepare("SELECT id,itemId FROM review_runs WHERE state='running'")
          .all();
        for (const row of rows) {
          const checked = z.object({ id: z.string(), itemId: z.string() }).parse(row);
          database
            .prepare(
              "UPDATE review_runs SET state='interrupted',reason='publication-uncertain',finishedAt=? WHERE id=?",
            )
            .run(new Date(now()).toISOString(), checked.id);
          database
            .prepare(
              "UPDATE review_queue SET status='blocked',reason='publication-uncertain' WHERE id=?",
            )
            .run(checked.itemId);
          database.prepare("UPDATE review_claims SET uncertain=1 WHERE runId=?").run(checked.id);
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
      return transaction(() => {
        const admitted = run(runId);
        if (
          !admitted ||
          !database
            .prepare("SELECT runId FROM review_claims WHERE runId=? AND uncertain=1")
            .get(runId)
        ) {
          throw new Error("Review run has no uncertain reservation to resolve");
        }
        switch (checked.action) {
          case "completed":
            completeResolution(admitted, checked.reason, checked.reviewedAt);
            break;
          case "retry":
            if (
              z
                .object({ reviewedAt: z.string().nullable() })
                .parse(database.prepare("SELECT reviewedAt FROM review_runs WHERE id=?").get(runId))
                .reviewedAt !== null
            ) {
              throw new Error(
                "Review completion is already recorded; resolve as completed instead of retrying",
              );
            }
            database
              .prepare("UPDATE review_runs SET resolution='retry',resolutionReason=? WHERE id=?")
              .run(checked.reason, runId);
            database
              .prepare("UPDATE review_queue SET status='queued',reason=NULL WHERE id=?")
              .run(admitted.itemId);
            break;
          default:
            throw new Error("Unknown review resolution");
        }
        database.prepare("DELETE FROM review_claims WHERE runId=?").run(runId);
      });
    },
    hasCompleted(
      reviewer: string,
      repository: string,
      number: number,
      requestEventId?: string,
      requestedAt?: string,
    ) {
      return database
        .prepare(
          "SELECT requestEventId,reviewedAt FROM reviewed_commits WHERE reviewer=? AND repository=? AND number=?",
        )
        .all(reviewer, repository, number)
        .some((row) => {
          const record = z
            .object({ requestEventId: z.string(), reviewedAt: z.iso.datetime() })
            .parse(row);
          return (
            (requestEventId !== undefined && record.requestEventId === requestEventId) ||
            requestedAt === undefined ||
            Date.parse(requestedAt) <= Date.parse(record.reviewedAt)
          );
        });
    },
    hasAttempted(
      reviewer: string,
      repository: string,
      number: number,
      requestEventId?: string,
      requestedAt?: string,
    ) {
      return database
        .prepare(`SELECT data,finishedAt FROM review_runs WHERE state!='running' AND reviewedAt IS NULL AND (resolution IS NULL OR resolution!='retry') AND itemId IN
        (SELECT id FROM review_queue WHERE reviewer=? AND repository=? AND number=?)`)
        .all(reviewer, repository, number)
        .some((row) => {
          const record = z
            .object({ data: z.string(), finishedAt: z.string().nullable() })
            .parse(row);
          const previous = StoreRunSchema.parse(JSON.parse(record.data));
          if (requestEventId !== undefined && previous.requestEventId === requestEventId)
            return true;
          return (
            requestedAt === undefined ||
            record.finishedAt === null ||
            Date.parse(requestedAt) <= Date.parse(record.finishedAt)
          );
        });
    },
    recordNotificationAttempt(runId: string) {
      return (
        database
          .prepare(
            "UPDATE review_runs SET notification='attempted' WHERE id=? AND state!='running' AND notification IS NULL",
          )
          .run(runId).changes === 1
      );
    },
    completeNotification(
      runId: string,
      status: "confirmed" | "failed" | "uncertain",
      error?: string,
    ) {
      database
        .prepare(
          "UPDATE review_runs SET notification=?,notificationError=? WHERE id=? AND notification='attempted'",
        )
        .run(
          z.enum(["confirmed", "failed", "uncertain"]).parse(status),
          error?.slice(0, 6000) ?? null,
          runId,
        );
    },
    claimDispatcher(owner: string) {
      return transaction(() => {
        const previous = readState("dispatcher");
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
        writeState("dispatcher", {
          owner,
          expiresAt: now() + LEASE_MS,
          host: hostname(),
          pid: process.pid,
        });
        return true;
      });
    },
    renewDispatcher(owner: string) {
      return transaction(() => {
        const previous = readState("dispatcher");
        if (!previous) return false;
        const lease = z.object({ owner: z.string(), expiresAt: z.number() }).parse(previous);
        if (lease.owner !== owner || lease.expiresAt <= now()) return false;
        writeState("dispatcher", {
          owner,
          expiresAt: now() + LEASE_MS,
          host: hostname(),
          pid: process.pid,
        });
        return true;
      });
    },
    releaseDispatcher(owner: string) {
      transaction(() => {
        const previous = readState("dispatcher");
        if (previous && z.object({ owner: z.string() }).parse(previous).owner === owner) {
          database.prepare("DELETE FROM poller_state WHERE key='dispatcher'").run();
        }
      });
    },
    bindReviewer(login: string) {
      const reviewer = z.string().trim().min(1).max(200).parse(login).toLowerCase();
      return transaction(() => {
        const previous = readState("reviewer");
        if (previous !== null && z.string().parse(previous) !== reviewer) {
          writeState("paused", true);
          return false;
        }
        writeState("reviewer", reviewer);
        return true;
      });
    },
    status() {
      return {
        paused: readState("paused") === true,
        reviewer:
          readState("reviewer") === null ? undefined : z.string().parse(readState("reviewer")),
        poll: readState("poll") ? PollUpdateSchema.parse(readState("poll")) : null,
        counts: database
          .prepare("SELECT status,COUNT(*) AS count FROM review_queue GROUP BY status")
          .all()
          .map((row) => z.object({ status: z.enum(QUEUE_STATES), count: z.number() }).parse(row)),
        reservations: database
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
          ),
      };
    },
    list(limit = 20) {
      return database
        .prepare(
          "SELECT * FROM review_queue ORDER BY seenAt DESC,createdAt,repository,number LIMIT ?",
        )
        .all(z.number().int().min(1).max(100).parse(limit))
        .map((row) => QueueItemSchema.parse(row));
    },
    details(id: string) {
      const selected = item(id) ?? item(run(id)?.itemId ?? "");
      if (!selected) return null;
      const runs = database
        .prepare(
          "SELECT data,state,finishedAt,reason,output,notification,notificationError,reviewedAt,reviewSummary,resolution,resolutionReason FROM review_runs WHERE itemId=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(selected.id)
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
          return {
            ...StoreRunSchema.parse(JSON.parse(checked.data)),
            status: checked.state,
            finishedAt: checked.finishedAt,
            reason: checked.reason,
            output: checked.output,
            notification: checked.notification,
            notificationError: checked.notificationError,
            reviewedAt: checked.reviewedAt,
            reviewSummary: checked.reviewSummary,
            resolution: checked.resolution,
            resolutionReason: checked.resolutionReason,
          };
        });
      return { item: selected, runs };
    },
    pause(paused: boolean) {
      writeState("paused", paused);
    },
    poll(update: PollUpdate) {
      const previous = readState("poll");
      const merged = {
        ...(previous ? PollUpdateSchema.parse(previous) : {}),
        ...PollUpdateSchema.parse(update),
      };
      writeState("poll", merged);
    },
    close() {
      database.close();
    },
  };
}
