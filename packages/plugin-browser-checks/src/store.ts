import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  BrowserJobSchema,
  BrowserRequestSchema,
  type BrowserJob,
  type BrowserRequest,
} from "./types.js";

/**
 * Long callback outages retry at most once per minute per job.
 */
const MAX_DELIVERY_DELAY_MS = 60_000;

const StoredJobSchema = z.object({
  data: z.string(),
  acknowledged: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  nextAt: z.number(),
});

/**
 * Only execution state can change after a request has been accepted.
 */
type BrowserChange = Partial<
  Pick<
    BrowserJob,
    | "state"
    | "plan"
    | "remote"
    | "remoteStopped"
    | "evidence"
    | "artifacts"
    | "result"
    | "error"
    | "configuration"
  >
>;

/**
 * Keep one dispatch owner and its latest unacknowledged job snapshots on disk.
 */
export function createBrowserStore(filename: string, now = Date.now) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      COMMIT;
    `);
    const version = z
      .object({ user_version: z.union([z.literal(0), z.literal(1)]) })
      .parse(database.prepare("PRAGMA user_version").get());
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_jobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        data TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        nextAt REAL NOT NULL,
        UNIQUE(owner, requestKey)
      );
    `);
    if (version.user_version === 0) database.exec("PRAGMA user_version = 1");
  } catch (err) {
    database.close();
    throw err;
  }

  function get(id: string): BrowserJob {
    return parseJob(read(id));
  }

  function read(id: string) {
    const row = database.prepare("SELECT * FROM browser_jobs WHERE id = ?").get(id);
    if (!row) throw new Error("Browser check not found");
    return StoredJobSchema.parse(row);
  }

  return {
    submit(owner: string, input: BrowserRequest, timeoutMs: number): BrowserJob {
      const request = BrowserRequestSchema.parse(input);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Browser check timeout must be positive");
      const previous = database
        .prepare("SELECT * FROM browser_jobs WHERE owner = ? AND requestKey = ?")
        .get(owner, request.requestKey);
      if (previous) {
        const job = parseJob(StoredJobSchema.parse(previous));
        if (JSON.stringify(job.request) !== JSON.stringify(request))
          throw new Error("Browser request key was already used for different instructions");
        return job;
      }
      const createdAt = now();
      const job = BrowserJobSchema.parse({
        id: randomUUID(),
        owner,
        request,
        state: "queued",
        version: 1,
        createdAt,
        deadline: createdAt + timeoutMs,
        updatedAt: createdAt,
        dispatchKey: randomUUID(),
        configuration: null,
        plan: null,
        remote: null,
        remoteStopped: null,
        evidence: null,
        artifacts: [],
        result: null,
        error: null,
      });
      database
        .prepare("INSERT INTO browser_jobs(id,owner,requestKey,data,nextAt) VALUES (?,?,?,?,?)")
        .run(job.id, owner, request.requestKey, JSON.stringify(job), createdAt);
      return job;
    },

    get,

    list(): BrowserJob[] {
      return database
        .prepare("SELECT * FROM browser_jobs ORDER BY rowid")
        .all()
        .map((row) => parseJob(StoredJobSchema.parse(row)));
    },

    update(id: string, change: BrowserChange): BrowserJob {
      const previous = get(id);
      const job = BrowserJobSchema.parse({
        ...previous,
        ...change,
        id: previous.id,
        owner: previous.owner,
        request: previous.request,
        createdAt: previous.createdAt,
        deadline: previous.deadline,
        dispatchKey: previous.dispatchKey,
        version: previous.version + 1,
        updatedAt: now(),
      });
      database
        .prepare("UPDATE browser_jobs SET data = ?, attempts = 0, nextAt = ? WHERE id = ?")
        .run(JSON.stringify(job), job.updatedAt, id);
      return job;
    },

    pendingUpdates() {
      return database
        .prepare("SELECT * FROM browser_jobs ORDER BY rowid")
        .all()
        .map((row) => StoredJobSchema.parse(row))
        .map((row) => ({ row, job: parseJob(row) }))
        .filter(({ row, job }) => row.acknowledged < job.version)
        .map(({ row, job }) => ({ job, attempts: row.attempts, nextAt: row.nextAt }));
    },

    acknowledge(id: string, version: number): void {
      const row = read(id);
      const job = parseJob(row);
      ensureVersion(version, job.version);
      database
        .prepare("UPDATE browser_jobs SET acknowledged = MAX(acknowledged, ?) WHERE id = ?")
        .run(version, id);
    },

    deliveryFailed(id: string, version: number): void {
      const row = read(id);
      const job = parseJob(row);
      ensureVersion(version, job.version);
      if (version !== job.version || row.acknowledged >= version) return;
      const delay = Math.min(MAX_DELIVERY_DELAY_MS, 1000 * 2 ** Math.min(row.attempts, 6));
      database
        .prepare("UPDATE browser_jobs SET attempts = ?, nextAt = ? WHERE id = ?")
        .run(row.attempts + 1, now() + delay, id);
    },

    close(): void {
      database.close();
    },
  };
}

/**
 * Validate saved snapshots before returning them to the dispatcher or its caller.
 */
function parseJob(row: z.infer<typeof StoredJobSchema>): BrowserJob {
  return BrowserJobSchema.parse(JSON.parse(row.data));
}

/**
 * A consumer can acknowledge only versions already saved by this store.
 */
function ensureVersion(version: number, current: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > current)
    throw new Error("Invalid browser update version");
}
