import type { Logger } from "@picco-agent/core";
import type { BrowserChecksOptions } from "./types.js";
import type { createBrowserStore } from "./store.js";

/**
 * Deliver saved snapshots independently from browser worker capacity.
 */
export function createUpdateDelivery(
  store: ReturnType<typeof createBrowserStore>,
  callback: BrowserChecksOptions["onUpdate"],
  logger: Logger,
) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const controller = new AbortController();

  async function deliver() {
    if (!callback) return;
    for (const { job, nextAt } of store.pendingUpdates()) {
      if (stopped) break;
      if (nextAt > Date.now()) continue;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 30000);
      const signal = AbortSignal.any([timeout.signal, controller.signal]);
      let abort: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("Update delivery stopped or timed out"));
          signal.addEventListener("abort", abort, { once: true });
        });
        await Promise.race([callback(job, signal), cancelled]);
        if (!stopped) store.acknowledge(job.id, job.version);
      } catch {
        if (!stopped) {
          store.deliveryFailed(job.id, job.version);
          logger.warning("Browser update delivery not acknowledged; saved update will be retried", {
            id: job.id,
            version: job.version,
          });
        }
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
      }
    }
  }

  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      pending ??= deliver().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async stop() {
      stopped = true;
      controller.abort();
      await pending;
    },
  };
}
