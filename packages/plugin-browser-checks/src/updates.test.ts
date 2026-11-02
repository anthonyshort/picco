import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBrowserStore } from "./store.js";
import { BrowserRequestSchema } from "./types.js";
import { createUpdateDelivery } from "./updates.js";

const resources: {
  directory: string;
  store: ReturnType<typeof createBrowserStore>;
  delivery: ReturnType<typeof createUpdateDelivery>;
}[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.delivery.stop();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser update delivery", () => {
  test("retries a rejected snapshot after its saved backoff and acknowledges success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let attempts = 0;
    const harness = createHarness(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Receiver unavailable");
    });
    await harness.delivery.tick();
    expect(harness.store.pendingUpdates()[0]).toMatchObject({ attempts: 1, nextAt: 2000 });
    await harness.delivery.tick();
    expect(attempts).toBe(1);
    vi.setSystemTime(2000);
    await harness.delivery.tick();
    expect(attempts).toBe(2);
    expect(harness.store.pendingUpdates()).toEqual([]);
    expect(harness.store.get(harness.job.id)).toEqual(harness.job);
  });

  test("does not acknowledge a newer snapshot through an older in-flight callback", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: number[] = [];
    const harness = createHarness(async (job) => {
      delivered.push(job.version);
      if (job.version === 1) await gate;
    });
    const pending = harness.delivery.tick();
    expect(harness.delivery.tick()).toBe(pending);
    harness.store.update(harness.job.id, { state: "running" });
    release?.();
    await pending;
    expect(harness.store.pendingUpdates()[0]?.job.version).toBe(2);
    await harness.delivery.tick();
    expect(delivered).toEqual([1, 2]);
    expect(harness.store.pendingUpdates()).toEqual([]);
  });

  test("stops an unresponsive callback without acknowledging or changing the job", async () => {
    let signal: AbortSignal | undefined;
    const harness = createHarness(async (_job, receivedSignal) => {
      signal = receivedSignal;
      await new Promise<void>(() => undefined);
    });
    const pending = harness.delivery.tick();
    await harness.delivery.stop();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(harness.store.pendingUpdates()[0]?.job).toEqual(harness.job);
    expect(harness.store.pendingUpdates()[0]?.attempts).toBe(0);
  });

  test("times out a stalled callback and retains its snapshot for retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const harness = createHarness(async () => {
      await new Promise<void>(() => undefined);
    });
    const pending = harness.delivery.tick();
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(harness.store.pendingUpdates()[0]).toMatchObject({
      attempts: 1,
      job: { id: harness.job.id, state: "queued" },
    });
  });
});

/**
 * Keep real callback bookkeeping and SQLite persistence beneath the delivery boundary.
 */
function createHarness(callback: Parameters<typeof createUpdateDelivery>[1]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-updates-"));
  const store = createBrowserStore(path.join(directory, "jobs.sqlite"));
  const job = store.submit(
    "host",
    BrowserRequestSchema.parse({
      requestKey: "filter",
      profile: "preview",
      question: "Does filtering work?",
      expected: "Filtered rows",
      url: "https://preview.example",
    }),
    5000,
  );
  const delivery = createUpdateDelivery(store, callback, createFakePluginContext().logger);
  resources.push({ directory, store, delivery });
  return { store, job, delivery };
}
