import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CronHistory, type JobRunRecord } from "./history.js";

let directory: string;
const stores: CronHistory[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cron-history-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await rm(directory, { recursive: true, force: true });
});

/**
 * Track store ownership so a failed assertion still releases its file lock.
 */
function open(history: ConstructorParameters<typeof CronHistory>[0] = {}) {
  const store = new CronHistory(history);
  stores.push(store);
  return store;
}

/**
 * Construct an independent run fixture without a prompt or command body.
 */
function record(status: JobRunRecord["status"] = "success"): JobRunRecord {
  return {
    id: randomUUID(),
    jobId: "digest",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    status,
    definition: {
      type: "agent",
      description: "A digest",
      schedule: "0 0 8 * * *",
      model: "local/test",
    },
  };
}

describe("CronHistory", () => {
  test("persists bounded terminal evidence and recovers incomplete work as interrupted", async () => {
    const file = path.join(directory, "runs.json");
    const store = open({ file, history: { maxOutputChars: 8 } });
    const done = { ...record(), output: "abcdefghijkl", finishedAt: new Date().toISOString() };
    const running = record("running");
    store.save(done);
    store.save(running);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    store.close();
    const recovered = open({ file, history: { maxOutputChars: 8 } });
    expect(recovered.list()).toEqual([
      expect.objectContaining({
        id: running.id,
        status: "interrupted",
        finishedAt: expect.any(String),
        reason: expect.stringContaining("unknown"),
      }),
      expect.objectContaining({
        id: done.id,
        status: "success",
        output: "abcdefgh",
        outputTruncated: true,
      }),
    ]);
    expect(JSON.parse(await readFile(file, "utf8")).runs[1].status).toBe("interrupted");
  });

  test("retains active work while pruning old terminal records and bounding capacity", () => {
    const store = open({ history: { maxRecords: 2 } });
    const active = record("running");
    store.save(active);
    const older = record();
    store.save(older);
    const newer = record();
    store.save(newer);
    expect(store.list().map((run) => run.id)).toEqual([newer.id, active.id]);
    const otherActive = record("running");
    store.save(otherActive);
    expect(store.list().every((run) => run.status === "running")).toBe(true);
    expect(() => store.save(record("running"))).toThrow("capacity");
    expect(store.list().map((run) => run.id)).toEqual([otherActive.id, active.id]);
  });

  test("history age limits exclude old completions and callers cannot mutate stored state", () => {
    const store = open({ history: { retentionDays: 1 } });
    store.save({ ...record(), startedAt: "2000-01-01T00:00:00.000Z" });
    const current = record();
    store.save(current);
    const first = store.list()[0];
    first.definition.model = "changed";
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].definition.model).toBe("local/test");
  });

  test("refuses simultaneous writers and reports corrupt history without discarding it", async () => {
    const file = path.join(directory, "runs.json");
    const store = open({ file });
    expect(() => open({ file })).toThrow("already open");
    store.close();
    await writeFile(file, "broken");
    expect(() => open({ file })).toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
    await writeFile(file, '{"version":1,"runs":[]}');
    expect(open({ file }).list()).toEqual([]);
  });
});
