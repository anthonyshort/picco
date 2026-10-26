import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { NotificationInputSchema } from "./types.js";
import type { NotificationAdapter, NotificationInput, NotificationResult } from "./types.js";

/**
 * Cached metadata excludes message text and credentials.
 */
interface Delivery extends Omit<NotificationResult, "duplicate"> {
  digest: string;
}

/**
 * Bound completed receipts and active attempts separately; TTL begins on completion.
 */
interface DeliveryOptions {
  max: number;
  ttl: number;
  timeoutMs: number;
}

/**
 * Share bounded process-local delivery tracking between host callbacks and the agent tool.
 */
export function createDeliveries(
  destinations: ReadonlyMap<string, NotificationAdapter>,
  options: DeliveryOptions,
) {
  const cache = new LRUCache<string, Delivery>({ max: options.max, ttl: options.ttl });
  const active = new Map<string, { delivery: Delivery; completion: Promise<NotificationResult> }>();
  let stopped = false;

  async function deliver(
    delivery: Delivery,
    adapter: NotificationAdapter,
    text: string,
  ): Promise<NotificationResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Notification send timed out"));
      }, options.timeoutMs);
    });
    try {
      const receipt = await Promise.race([adapter.send(text, controller.signal), timeout]);
      delivery.status = receipt.status;
      if (receipt.status === "confirmed") delivery.externalId = receipt.externalId ?? null;
    } catch {
      delivery.status = "uncertain";
    } finally {
      clearTimeout(timer);
    }
    return result(delivery, false);
  }

  return {
    async notify(input: NotificationInput): Promise<NotificationResult> {
      if (stopped) throw new Error("Notifications are stopped");
      const { destination, text, deduplicationKey } = NotificationInputSchema.parse(input);
      const adapter = destinations.get(destination);
      if (!adapter) throw new Error("Unknown notification destination");
      const intent =
        deduplicationKey === undefined ? `id:${randomUUID()}` : `key:${deduplicationKey}`;
      const key = JSON.stringify([destination, intent]);
      const digest = createHash("sha256").update(text).digest("hex");
      const previous = active.get(key)?.delivery ?? cache.get(key);
      if (previous) {
        if (previous.digest !== digest)
          throw new Error("Notification key was already used for different content");
        return result(previous, true);
      }
      if (active.size >= options.max)
        throw new Error("Notification capacity reached; wait for active attempts");
      const delivery: Delivery = {
        deliveryId: randomUUID(),
        destination,
        digest,
        status: "in-flight",
        externalId: null,
      };
      const completion = Promise.resolve().then(async () => {
        try {
          return await deliver(delivery, adapter, text);
        } finally {
          cache.set(key, delivery);
          active.delete(key);
        }
      });
      active.set(key, { delivery, completion });
      return completion;
    },
    delivery(deliveryId: string): NotificationResult | undefined {
      for (const { delivery } of active.values()) {
        if (delivery.deliveryId === deliveryId) return result(delivery, true);
      }
      for (const delivery of cache.values()) {
        if (delivery.deliveryId === deliveryId) return result(delivery, true);
      }
      return undefined;
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.allSettled([...active.values()].map(({ completion }) => completion));
      cache.clear();
    },
  };
}

/**
 * Limit user-visible output to safe receipt metadata.
 */
function result(delivery: Delivery, duplicate: boolean): NotificationResult {
  return {
    deliveryId: delivery.deliveryId,
    destination: delivery.destination,
    status: delivery.status,
    externalId: delivery.externalId,
    duplicate,
  };
}
