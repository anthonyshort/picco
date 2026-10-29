import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RateLimitSchema } from "./github-contracts.js";
import { FeedbackCandidateSchema, type FeedbackCandidate } from "./feedback-source.js";
import {
  FeedbackCompletionSchema,
  FeedbackRunSchema,
  type FeedbackCompletion,
} from "./feedback-types.js";

/**
 * Stop admitting work when dispatcher ownership has not been renewed for five minutes.
 */
const LEASE_MS = 5 * 60_000;

/**
 * Worker outcome recorded after its session is closed.
 */
const OutcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "interrupted"]),
  output: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Last discovery attempt and its persisted retry deadline.
 */
const PollSchema = z.object({
  attemptedAt: z.iso.datetime().optional(),
  successfulAt: z.iso.datetime().optional(),
  nextPollAt: z.iso.datetime().optional(),
  error: z.string().nullable().optional(),
  rateLimit: RateLimitSchema.optional(),
});

/**
 * Decode SQLite payloads before passing them to domain schemas.
 */
const DataRowSchema = z.object({ data: z.string() });

/**
 * Open the SQLite queue shared by discovery, the dispatcher and worker completion. PR metadata is
 * refreshed from GitHub; review IDs retain their handling state across head changes and restarts.
 * Admission freezes one batch in a transaction, and uncertain attempts block that PR until an
 * operator records a resolution.
 */
export function createFeedbackStore(filename: string, now = Date.now) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS feedback_state(key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback_dispatcher(
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      host TEXT NOT NULL, pid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback_prs(
      key TEXT PRIMARY KEY, data TEXT NOT NULL, present INTEGER NOT NULL DEFAULT 1,
      blockedRunId TEXT, resumeRunId TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_reviews(
      id TEXT PRIMARY KEY, prKey TEXT NOT NULL REFERENCES feedback_prs(key), observedAt INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','running','completed','withdrawn')), runId TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_runs(
      id TEXT PRIMARY KEY, prKey TEXT NOT NULL REFERENCES feedback_prs(key), data TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','completed','blocked','interrupted')),
      declaration TEXT, outcome TEXT, resolution TEXT, resolutionReason TEXT
    );
    CREATE INDEX IF NOT EXISTS feedback_pending ON feedback_reviews(prKey,state,observedAt);
  `);

  let dispatcherOwner: string | undefined;

  function assertOwnership() {
    if (
      dispatcherOwner &&
      !database
        .prepare("SELECT owner FROM feedback_dispatcher WHERE id=1 AND owner=? AND expiresAt>?")
        .get(dispatcherOwner, now())
    ) {
      throw new Error("Feedback dispatcher ownership was lost");
    }
  }

  /**
   * Commit each queue transition atomically, rolling back on failure. Once this store has claimed a
   * dispatcher lease, mutations normally require that lease to remain live; claiming the lease
   * itself must run without that ownership check.
   */
  function transaction<Result>(operation: () => Result, requireOwnership = true): Result {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (requireOwnership) assertOwnership();
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  }

  function readState(key: string): unknown {
    const row = database.prepare("SELECT data FROM feedback_state WHERE key=?").get(key);
    return row ? JSON.parse(DataRowSchema.parse(row).data) : undefined;
  }

  function writeState(key: string, data: unknown) {
    assertOwnership();
    database
      .prepare(`INSERT INTO feedback_state(key,data) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET data=excluded.data`)
      .run(key, JSON.stringify(data));
  }

  /**
   * Bind persisted review history to one account. A different login pauses admissions and returns
   * false so reconciliation cannot mix feedback from different accounts.
   */
  function bindAuthor(author: string) {
    return transaction(() => {
      const login = author.toLowerCase();
      const previous = readState("author");
      if (previous !== undefined && previous !== login) {
        writeState("paused", true);
        return false;
      }
      writeState("author", login);
      return true;
    });
  }

  /**
   * Intersect the latest GitHub reviews with IDs still pending in SQLite. Completed IDs remain
   * handled even when discovery sees them again at another PR head.
   */
  function pending(candidate: FeedbackCandidate) {
    const ids = new Set(
      database
        .prepare("SELECT id FROM feedback_reviews WHERE prKey=? AND state='pending'")
        .all(prKey(candidate))
        .map((row) => z.object({ id: z.string() }).parse(row).id),
    );
    return candidate.reviews.filter((review) => ids.has(review.id));
  }

  /**
   * Select pending reviews for a fresh batch, or only the original batch's IDs on retry. New
   * reviews must wait for a later run rather than expand resumed work.
   */
  function selectedPending(candidate: FeedbackCandidate) {
    const row = database
      .prepare("SELECT resumeRunId FROM feedback_prs WHERE key=?")
      .get(prKey(candidate));
    const resumeRunId = z.object({ resumeRunId: z.string().nullable() }).parse(row).resumeRunId;
    const reviews = pending(candidate);
    if (!resumeRunId) return reviews;
    const originalIds = new Set(runRow(resumeRunId).run.reviews.map((review) => review.id));
    return reviews.filter((review) => originalIds.has(review.id));
  }

  /**
   * Measure debounce from when pending review IDs were first observed locally. A PR is ready after
   * the last observation's quiet period or the first observation's maximum wait, whichever comes
   * first. Repeated polls of the same IDs do not reset it.
   */
  function eligible(candidate: FeedbackCandidate, debounceMs: number, maxWaitMs: number) {
    const row = database
      .prepare(`SELECT MIN(observedAt) AS first, MAX(observedAt) AS last
      FROM feedback_reviews WHERE prKey=? AND state='pending'`)
      .get(prKey(candidate));
    const bounds = z
      .object({ first: z.number().nullable(), last: z.number().nullable() })
      .parse(row);
    return (
      bounds.first !== null &&
      bounds.last !== null &&
      now() >= Math.min(bounds.last + debounceMs, bounds.first + maxWaitMs)
    );
  }

  function runRow(id: string) {
    const row = database.prepare("SELECT * FROM feedback_runs WHERE id=?").get(id);
    if (!row) throw new Error("Feedback run does not exist");
    const checked = z
      .object({
        id: z.string(),
        prKey: z.string(),
        data: z.string(),
        state: z.enum(["running", "completed", "blocked", "interrupted"]),
        declaration: z.string().nullable(),
        outcome: z.string().nullable(),
        resolution: z.string().nullable(),
        resolutionReason: z.string().nullable(),
      })
      .parse(row);
    return {
      ...checked,
      run: FeedbackRunSchema.parse(JSON.parse(checked.data)),
      declaration: checked.declaration
        ? FeedbackCompletionSchema.parse(JSON.parse(checked.declaration))
        : undefined,
      outcome: checked.outcome ? OutcomeSchema.parse(JSON.parse(checked.outcome)) : undefined,
    };
  }

  return {
    bindAuthor,
    /**
     * Replace PR presence and metadata using a successful discovery result, and insert new review
     * IDs as pending without resetting existing IDs or observation times. Pending reviews missing
     * from a supplied PR's current reviews become withdrawn; PRs absent from the result cannot be
     * admitted. No worker starts here.
     */
    reconcile(author: string, candidates: FeedbackCandidate[]) {
      const checked = z.array(FeedbackCandidateSchema).max(100_000).parse(candidates);
      if (!bindAuthor(author)) throw new Error("Authenticated GitHub author changed");
      transaction(() => {
        database.prepare("UPDATE feedback_prs SET present=0").run();
        for (const candidate of checked) {
          const key = prKey(candidate);
          database
            .prepare(`INSERT INTO feedback_prs(key,data,present) VALUES (?,?,1)
            ON CONFLICT(key) DO UPDATE SET data=excluded.data,present=1`)
            .run(key, JSON.stringify(candidate));
          const live = new Set(candidate.reviews.map((review) => review.id));
          for (const review of candidate.reviews) {
            database
              .prepare(`INSERT OR IGNORE INTO feedback_reviews(id,prKey,observedAt,state)
              VALUES (?,?,?,'pending')`)
              .run(review.id, key, now());
          }
          for (const row of database
            .prepare("SELECT id FROM feedback_reviews WHERE prKey=? AND state='pending'")
            .all(key)) {
            const { id } = z.object({ id: z.string() }).parse(row);
            if (!live.has(id))
              database.prepare("UPDATE feedback_reviews SET state='withdrawn' WHERE id=?").run(id);
          }
          const retry = z
            .object({ resumeRunId: z.string().nullable() })
            .parse(database.prepare("SELECT resumeRunId FROM feedback_prs WHERE key=?").get(key));
          if (retry.resumeRunId && !selectedPending(candidate).length) {
            database.prepare("UPDATE feedback_prs SET resumeRunId=NULL WHERE key=?").run(key);
          }
        }
      });
    },
    /**
     * Read present, unblocked PRs whose pending reviews satisfy debounce, oldest first. This is a
     * preview, not a reservation: the dispatcher reinspects GitHub and calls admit before starting
     * a worker. Retries retain only the original batch's pending IDs.
     */
    next(debounceMs: number, maxWaitMs: number) {
      return database
        .prepare(`SELECT p.data FROM feedback_prs p JOIN feedback_reviews r ON r.prKey=p.key
        WHERE p.present=1 AND p.blockedRunId IS NULL AND r.state='pending'
        GROUP BY p.key ORDER BY MIN(r.observedAt),p.key`)
        .all()
        .map((row) => FeedbackCandidateSchema.parse(JSON.parse(DataRowSchema.parse(row).data)))
        .filter((candidate) => eligible(candidate, debounceMs, maxWaitMs))
        .map((candidate) => ({ ...candidate, reviews: selectedPending(candidate) }));
    },
    /**
     * Atomically reserve a batch after the dispatcher has rechecked GitHub and reconciled it.
     * Recheck account, pause, debounce and PR blocking state, and reject admission while any run is
     * running. Freeze the supplied head and selected pending reviews in a new run, marking those
     * IDs running so later discoveries cannot expand this batch.
     */
    admit(candidate: FeedbackCandidate, author: string, debounceMs: number, maxWaitMs: number) {
      const checked = FeedbackCandidateSchema.parse(candidate);
      return transaction(() => {
        if (readState("paused") === true || readState("author") !== author.toLowerCase())
          return null;
        if (database.prepare("SELECT id FROM feedback_runs WHERE state='running'").get())
          return null;
        const row = database
          .prepare("SELECT present,blockedRunId,resumeRunId FROM feedback_prs WHERE key=?")
          .get(prKey(checked));
        if (!row) return null;
        const item = z
          .object({
            present: z.number(),
            blockedRunId: z.string().nullable(),
            resumeRunId: z.string().nullable(),
          })
          .parse(row);
        if (!item.present || item.blockedRunId || !eligible(checked, debounceMs, maxWaitMs))
          return null;
        const reviews = selectedPending(checked);
        if (!reviews.length) return null;
        const id = randomUUID();
        const run = FeedbackRunSchema.parse({
          ...checked,
          reviews,
          id,
          author: author.toLowerCase(),
          sessionKey: id,
          startedAt: new Date(now()).toISOString(),
          resumeRunId: item.resumeRunId ?? undefined,
        });
        database
          .prepare("INSERT INTO feedback_runs(id,prKey,data,state) VALUES (?,?,?,'running')")
          .run(id, prKey(checked), JSON.stringify(run));
        for (const review of reviews)
          database
            .prepare(
              "UPDATE feedback_reviews SET state='running',runId=? WHERE id=? AND state='pending'",
            )
            .run(id, review.id);
        database
          .prepare("UPDATE feedback_prs SET resumeRunId=NULL WHERE key=?")
          .run(prKey(checked));
        return run;
      });
    },
    /**
     * Save the running worker's completion declaration before teardown. This records reported
     * evidence without performing or independently verifying GitHub writes. Declaration alone does
     * not mark reviews handled: the normal worker path does that in finish, while an operator can
     * separately resolve uncertain work.
     */
    declare(runId: string, evidence: FeedbackCompletion) {
      const checked = FeedbackCompletionSchema.parse(evidence);
      return transaction(
        () =>
          database
            .prepare("UPDATE feedback_runs SET declaration=? WHERE id=? AND state='running'")
            .run(JSON.stringify(checked), runId).changes === 1,
      );
    },
    /**
     * Record the outcome after the runner attempts teardown. Completion requires a declaration and
     * marks the batch's review IDs handled. Blocked or interrupted outcomes instead block further
     * work on that PR until resolve records how to proceed.
     */
    finish(runId: string, outcome: z.infer<typeof OutcomeSchema>) {
      const checked = OutcomeSchema.parse(outcome);
      transaction(() => {
        const previous = runRow(runId);
        if (previous.state !== "running") throw new Error("Feedback run is no longer running");
        if (checked.status === "completed" && !previous.declaration)
          throw new Error("Feedback completion requires a declaration");
        database
          .prepare("UPDATE feedback_runs SET state=?,outcome=? WHERE id=?")
          .run(checked.status, JSON.stringify(checked), runId);
        if (checked.status === "completed") {
          database
            .prepare("UPDATE feedback_reviews SET state='completed' WHERE runId=?")
            .run(runId);
        } else {
          database
            .prepare("UPDATE feedback_prs SET blockedRunId=? WHERE key=?")
            .run(runId, previous.prKey);
        }
      });
    },
    /**
     * Apply an operator's evidence-based decision for a blocked or interrupted run. Completed marks
     * its reviews handled; retry requeues them and retains the original artifact/run reference. The
     * caller must first confirm the prior worker has stopped.
     */
    resolve(runId: string, action: "completed" | "retry", reason: string) {
      const checked = z
        .object({
          action: z.enum(["completed", "retry"]),
          reason: z.string().trim().min(1).max(4000),
        })
        .parse({ action, reason });
      transaction(() => {
        const previous = runRow(runId);
        if (previous.state !== "blocked" && previous.state !== "interrupted")
          throw new Error("Only a stopped, uncertain feedback run may be resolved");
        const blocked = database
          .prepare("SELECT key FROM feedback_prs WHERE blockedRunId=?")
          .get(runId);
        if (!blocked) throw new Error("Feedback run was already resolved");
        switch (checked.action) {
          case "completed":
            database
              .prepare("UPDATE feedback_reviews SET state='completed' WHERE runId=?")
              .run(runId);
            database.prepare("UPDATE feedback_runs SET state='completed' WHERE id=?").run(runId);
            database
              .prepare("UPDATE feedback_prs SET blockedRunId=NULL,resumeRunId=NULL WHERE key=?")
              .run(previous.prKey);
            break;
          case "retry":
            database
              .prepare("UPDATE feedback_reviews SET state='pending',runId=NULL WHERE runId=?")
              .run(runId);
            database
              .prepare("UPDATE feedback_prs SET blockedRunId=NULL,resumeRunId=? WHERE key=?")
              .run(previous.run.resumeRunId ?? previous.run.id, previous.prKey);
            break;
          default:
            throw new Error("Unknown feedback resolution");
        }
        database
          .prepare("UPDATE feedback_runs SET resolution=?,resolutionReason=? WHERE id=?")
          .run(checked.action, checked.reason, runId);
      });
    },
    /**
     * On startup, mark previously running attempts interrupted and block their PRs. Never
     * automatically replay uncertain work: a prior worker may already have pushed or published
     * before the process lost its final outcome.
     */
    recoverInterrupted() {
      return transaction(() => {
        const running = database
          .prepare("SELECT id,prKey FROM feedback_runs WHERE state='running'")
          .all();
        for (const row of running) {
          const previous = z.object({ id: z.string(), prKey: z.string() }).parse(row);
          database.prepare("UPDATE feedback_runs SET state='interrupted',outcome=? WHERE id=?").run(
            JSON.stringify({
              status: "interrupted",
              error: "Worker stopped before its outcome was recorded",
            }),
            previous.id,
          );
          database
            .prepare("UPDATE feedback_prs SET blockedRunId=? WHERE key=?")
            .run(previous.id, previous.prKey);
        }
        return running.length;
      });
    },
    pause(paused: boolean) {
      transaction(() => writeState("paused", paused));
    },
    /**
     * Merge discovery status and retry timing into persistent state so a restart can respect the
     * previous poll's backoff. This records status without contacting GitHub.
     */
    poll(update: z.infer<typeof PollSchema>) {
      transaction(() =>
        writeState("poll", {
          ...PollSchema.parse(readState("poll") ?? {}),
          ...PollSchema.parse(update),
        }),
      );
    },
    status() {
      return {
        author: z.string().optional().parse(readState("author")),
        paused: readState("paused") === true,
        poll: PollSchema.optional().parse(readState("poll")),
        queue: database
          .prepare(`SELECT p.key,p.blockedRunId,COUNT(CASE WHEN r.state='pending' THEN 1 END) AS pending
          FROM feedback_prs p LEFT JOIN feedback_reviews r ON r.prKey=p.key
          GROUP BY p.key ORDER BY p.key`)
          .all(),
        activeRuns: database
          .prepare("SELECT id FROM feedback_runs WHERE state='running'")
          .all()
          .map((row) => z.object({ id: z.string() }).parse(row).id),
      };
    },
    list(limit = 20) {
      return database
        .prepare(
          "SELECT key,data,present,blockedRunId,resumeRunId FROM feedback_prs ORDER BY key LIMIT ?",
        )
        .all(z.number().int().min(1).max(100).parse(limit))
        .map((row) => {
          const item = z
            .object({
              key: z.string(),
              data: z.string(),
              present: z.number(),
              blockedRunId: z.string().nullable(),
              resumeRunId: z.string().nullable(),
            })
            .parse(row);
          const candidate = FeedbackCandidateSchema.parse(JSON.parse(item.data));
          return {
            ...candidate,
            present: Boolean(item.present),
            blockedRunId: item.blockedRunId,
            resumeRunId: item.resumeRunId,
            pending: pending(candidate).map((review) => review.id),
          };
        });
    },
    details: runRow,
    /**
     * Claim the single dispatcher lease for this database. Refuse another live lease; reclaim an
     * expired foreign owner only on this host when its process is confirmed gone. Remember
     * ownership locally so subsequent queue mutations check the live lease.
     */
    claimDispatcher(owner: string) {
      const claimed = transaction(() => {
        const row = database
          .prepare("SELECT owner,expiresAt,host,pid FROM feedback_dispatcher WHERE id=1")
          .get();
        if (row) {
          const previous = z
            .object({
              owner: z.string(),
              expiresAt: z.number(),
              host: z.string(),
              pid: z.number().int().positive(),
            })
            .parse(row);
          if (previous.owner !== owner) {
            if (previous.expiresAt > now() || previous.host !== hostname()) return false;
            try {
              process.kill(previous.pid, 0);
              return false;
            } catch (err) {
              if (!z.object({ code: z.literal("ESRCH") }).safeParse(err).success) return false;
            }
          }
        }
        database
          .prepare(`INSERT INTO feedback_dispatcher(id,owner,expiresAt,host,pid) VALUES (1,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt,host=excluded.host,pid=excluded.pid`)
          .run(owner, now() + LEASE_MS, hostname(), process.pid);
        return true;
      }, false);
      if (claimed) dispatcherOwner = owner;
      return claimed;
    },
    /**
     * Extend this owner's unexpired lease. Return false after expiry or replacement so the
     * dispatcher can stop admissions and abort its worker instead of continuing unowned.
     */
    renewDispatcher(owner: string) {
      return (
        database
          .prepare(
            "UPDATE feedback_dispatcher SET expiresAt=? WHERE id=1 AND owner=? AND expiresAt>?",
          )
          .run(now() + LEASE_MS, owner, now()).changes === 1
      );
    },
    releaseDispatcher(owner: string) {
      database.prepare("DELETE FROM feedback_dispatcher WHERE id=1 AND owner=?").run(owner);
    },
    close() {
      database.close();
    },
  };
}

/**
 * Repository names are canonicalised by the discovery schema.
 */
function prKey(candidate: FeedbackCandidate) {
  return `${candidate.repository}#${candidate.number}`;
}
