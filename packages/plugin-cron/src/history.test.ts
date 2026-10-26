import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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
 * Close each real database even if an assertion fails.
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
  test("persists bounded evidence and recovers incomplete work as interrupted", async () => {
    const file = path.join(directory, "runs.sqlite");
    const store = open({ file, history: { maxOutputChars: 8 } });
    const done = {
      ...record(),
      output: "abcdefghijkl",
      error: "abcdefghijkl",
      executionId: "execution-one",
      finalisationErrors: ["cleanup failed"],
      finishedAt: new Date().toISOString(),
    };
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
        error: "abcdefgh",
        executionId: "execution-one",
        finalisationErrors: ["cleanup failed"],
        outputTruncated: true,
      }),
    ]);
    recovered.close();
    const database = new DatabaseSync(file);
    try {
      expect(database.prepare("SELECT status FROM runs WHERE id = ?").get(running.id)).toEqual({
        status: "interrupted",
      });
    } finally {
      database.close();
    }
  });

  test("queries ordered job pages and counts without decoding unselected records", () => {
    const file = path.join(directory, "runs.sqlite");
    const store = open({ file });
    const first = { ...record(), startedAt: "2099-01-01T00:00:00.000Z" };
    const second = { ...record("error"), startedAt: "2099-01-02T00:00:00.000Z" };
    const third = { ...record("skipped"), startedAt: "2099-01-03T00:00:00.000Z" };
    store.save(first);
    store.save(second);
    store.save(third);
    const other = { ...record(), jobId: "other", startedAt: "2099-01-04T00:00:00.000Z" };
    store.save(other);
    expect(store.list("digest", 1, 1).map((run) => run.id)).toEqual([second.id]);
    expect(store.list(undefined, 2, 1).map((run) => run.id)).toEqual([third.id, second.id]);
    expect(store.count("digest")).toBe(3);
    expect(store.count()).toBe(4);
    expect(store.count("missing")).toBe(0);
    expect(store.list("digest", 1, 3)).toEqual([]);
    expect(store.completed("digest")).toEqual({ fireCount: 2, lastRun: second.startedAt });
    expect(store.completed("missing")).toEqual({ fireCount: 0, lastRun: null });
    store.close();
    const database = new DatabaseSync(file);
    database.prepare("UPDATE runs SET definition = 'damaged' WHERE id = ?").run(other.id);
    database.close();
    const reopened = open({ file });
    expect(reopened.list("digest", 1)[0].id).toBe(third.id);
    expect(() => reopened.list(undefined, 1)).toThrow();
  });

  test("upserts one run and rolls back failed admission without pruning other work", () => {
    const store = open({ history: { maxRecords: 2 } });
    const first = record("running");
    const second = record("running");
    store.save(first);
    store.save(second);
    expect(() => store.save(record("running"))).toThrow("capacity");
    expect(store.list().map((run) => run.id)).toEqual([second.id, first.id]);
    store.save({ ...first, status: "success", output: "finished" });
    expect(store.count()).toBe(2);
    expect(store.list().find((run) => run.id === first.id)?.output).toBe("finished");
    const third = record();
    store.save(third);
    expect(store.list().map((run) => run.id)).toEqual([third.id, second.id]);
    expect(store.completed("digest").fireCount).toBe(1);
  });

  test("prunes by completion age and returns independent record values", () => {
    const store = open({ history: { retentionDays: 1 } });
    store.save({ ...record(), startedAt: "2000-01-01T00:00:00.000Z" });
    const active = { ...record("running"), startedAt: "2000-01-01T00:00:00.000Z" };
    store.save(active);
    const current = {
      ...record(),
      startedAt: "2000-01-01T00:00:00.000Z",
      finishedAt: new Date().toISOString(),
    };
    store.save(current);
    expect(store.count()).toBe(2);
    const first = store.list()[0];
    first.definition.model = "changed";
    expect(store.list()[0].definition.model).toBe("local/test");
  });

  test("refuses a second owner without interrupting live work and preserves corrupt files", async () => {
    const file = path.join(directory, "runs.sqlite");
    const store = open({ file });
    const running = record("running");
    store.save(running);
    expect(() => open({ file })).toThrow("locked");
    expect(store.list()[0].status).toBe("running");
    store.close();
    await writeFile(file, "broken");
    expect(() => open({ file })).toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
  });

  test("the operating system releases ownership after a crash, preserving committed runs", async () => {
    const file = path.join(directory, "runs.sqlite");
    const running = record("running");
    const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "history.ts")).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { CronHistory } from ${JSON.stringify(moduleUrl)};
      const store = new CronHistory({ file: process.argv[1] });
      store.save(JSON.parse(process.argv[2]));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
        file,
        JSON.stringify(running),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error(`History owner exited before readiness: ${errors}`);
        }),
      ]);
      expect(() => open({ file })).toThrow("locked");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const recovered = open({ file });
      expect(recovered.list()[0]).toMatchObject({ id: running.id, status: "interrupted" });
      expect(recovered.list()[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});
