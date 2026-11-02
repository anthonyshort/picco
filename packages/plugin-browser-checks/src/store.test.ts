import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { createBrowserStore } from "./store.js";
import { BrowserRequestSchema } from "./types.js";

const directories: string[] = [];
const stores: ReturnType<typeof createBrowserStore>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("browser store", () => {
  test("reuses canonical requests across restart without extending their deadline", () => {
    const filename = createFilename();
    let time = 1000;
    const first = openStore(filename, () => time);
    const request = createRequest();
    const original = first.submit("review-worker", request, 5000);
    first.close();
    stores.splice(stores.indexOf(first), 1);
    time = 3000;
    const second = openStore(filename, () => time);
    const reordered = BrowserRequestSchema.parse({
      expected: request.expected,
      question: request.question,
      profile: request.profile,
      requestKey: request.requestKey,
      url: request.url,
    });
    expect(second.submit("review-worker", reordered, 9000)).toEqual(original);
    expect(second.list()).toEqual([original]);
    expect(second.submit("different-worker", request, 5000).id).not.toBe(original.id);
  });

  test("rejects a conflicting request key without changing the original job", () => {
    const store = openStore(createFilename());
    const request = createRequest();
    const job = store.submit("owner", request, 5000);
    expect(() =>
      store.submit("owner", { ...request, expected: "Something different" }, 5000),
    ).toThrow("already used");
    expect(store.get(job.id)).toEqual(job);
  });

  test("saves versioned state and keeps snapshots separate from returned objects", () => {
    let time = 1000;
    const store = openStore(createFilename(), () => time);
    const job = store.submit("owner", createRequest(), 5000);
    time = 1500;
    const updated = store.update(job.id, {
      state: "running",
      remote: { runId: "remote-run", threadId: "remote-thread" },
    });
    expect(updated).toMatchObject({
      state: "running",
      version: 2,
      updatedAt: 1500,
      deadline: 6000,
    });
    updated.remote!.runId = "changed outside store";
    expect(store.get(job.id).remote?.runId).toBe("remote-run");
    expect(job.version).toBe(1);
    expect(store.pendingUpdates()).toEqual([{ job: store.get(job.id), attempts: 0, nextAt: 1500 }]);
  });

  test("stale acknowledgements and failures cannot discard a newer update", () => {
    const store = openStore(createFilename(), () => 1000);
    const job = store.submit("owner", createRequest(), 5000);
    const updated = store.update(job.id, { state: "preparing" });
    store.acknowledge(job.id, 1);
    store.deliveryFailed(job.id, 1);
    expect(store.pendingUpdates()).toEqual([{ job: updated, attempts: 0, nextAt: 1000 }]);
    store.acknowledge(job.id, 2);
    store.acknowledge(job.id, 1);
    store.deliveryFailed(job.id, 2);
    expect(store.pendingUpdates()).toEqual([]);
    expect(() => store.acknowledge(job.id, 3)).toThrow("Invalid browser update version");
    expect(() => store.deliveryFailed(job.id, 0)).toThrow("Invalid browser update version");
  });

  test("persists callback backoff and resets it when new evidence is saved", () => {
    const filename = createFilename();
    let time = 1000;
    const first = openStore(filename, () => time);
    const job = first.submit("owner", createRequest(), 5000);
    first.deliveryFailed(job.id, 1);
    expect(first.pendingUpdates()[0]).toMatchObject({ attempts: 1, nextAt: 2000 });
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const second = openStore(filename, () => time);
    second.deliveryFailed(job.id, 1);
    expect(second.pendingUpdates()[0]).toMatchObject({ attempts: 2, nextAt: 3000 });
    for (let attempt = 0; attempt < 10; attempt++) second.deliveryFailed(job.id, 1);
    expect(second.pendingUpdates()[0]?.nextAt).toBe(61_000);
    time = 2500;
    const updated = second.update(job.id, { state: "blocked", error: "No test fixture" });
    expect(second.pendingUpdates()).toEqual([{ job: updated, attempts: 0, nextAt: 2500 }]);
  });

  test("retains a single database owner until the store closes", () => {
    const filename = createFilename();
    const first = openStore(filename);
    first.submit("owner", createRequest(), 5000);
    expect(() => createBrowserStore(filename)).toThrow(/locked/);
    first.close();
    stores.splice(stores.indexOf(first), 1);
    expect(openStore(filename).list()).toHaveLength(1);
  });

  test("creates private files and rejects invalid requests and unknown jobs", () => {
    const filename = createFilename();
    const store = openStore(filename);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(filename)).mode & 0o777).toBe(0o700);
    expect(() => store.get("missing")).toThrow("not found");
    expect(() => store.submit("owner", createRequest(), 0)).toThrow("timeout");
    expect(() => store.submit("owner", createRequest(), Number.POSITIVE_INFINITY)).toThrow(
      "timeout",
    );
    expect(store.list()).toEqual([]);
  });

  test("rejects unsupported saved schemas and releases their database lock", () => {
    const filename = createFilename();
    const first = openStore(filename);
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const database = new DatabaseSync(filename);
    database.exec("PRAGMA user_version = 2");
    database.close();
    expect(() => createBrowserStore(filename)).toThrow();
    const repaired = new DatabaseSync(filename);
    repaired.exec("PRAGMA user_version = 1");
    repaired.close();
    expect(openStore(filename).list()).toEqual([]);
  });
});

/**
 * Track open stores so failed assertions do not retain an exclusive database lock.
 */
function openStore(filename: string, now?: () => number) {
  const store = createBrowserStore(filename, now);
  stores.push(store);
  return store;
}

/**
 * Put each database in a newly created private plugin directory.
 */
function createFilename() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-store-"));
  directories.push(directory);
  return path.join(directory, "plugin", "jobs.sqlite");
}

/**
 * Defaults match the request shape accepted by the plugin tools.
 */
function createRequest() {
  return BrowserRequestSchema.parse({
    requestKey: "request-1",
    profile: "preview",
    question: "Does changing status filter the rows?",
    expected: "Only rows matching the new status remain",
    url: "https://preview.example.test/settings",
  });
}
