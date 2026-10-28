import { createHash, randomUUID } from "node:crypto";
import * as z from "zod";
import { NotificationBroadcastSchema, DELIVERY_STATUSES } from "./types.js";
import type {
  AdapterResult,
  NotificationAdapter,
  NotificationBroadcast,
  NotificationBroadcastResult,
  NotificationResult,
} from "./types.js";

/**
 * Recipient-bound state excludes message text and credentials.
 */
export const MessageRecordSchema = z.object({
  targetId: z.string().min(1).max(1000),
  digest: z.string(),
  deliveryId: z.uuid(),
  destination: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  externalId: z.string().nullable(),
});

/**
 * One channel's latest attempt for a scoped logical message.
 */
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

/**
 * Synchronous reservations must be saved before calling an external adapter.
 */
export interface MessageStore {
  get(key: string): MessageRecord | undefined;
  set(key: string, record: MessageRecord): void;
  close(): void;
}

/**
 * Bound queued requests and transport waits independently of receipt caching.
 */
export interface MessageOptions {
  max: number;
  timeoutMs: number;
}

/**
 * Broadcast independently and serialise edits to each scoped channel message.
 */
export function createMessages(
  resolveDestinations: (scope: string) => Record<string, NotificationAdapter>,
  options: MessageOptions,
  store: MessageStore = createMessageStore(options.max),
) {
  const tails = new Map<string, Promise<NotificationResult>>();
  const receipts = new Map<string, NotificationResult>();
  let pendingDeliveries = 0;
  let stopped = false;

  async function deliver(
    key: string,
    destination: string,
    adapter: NotificationAdapter,
    text: string,
    keyed: boolean,
  ): Promise<NotificationResult> {
    const digest = createHash("sha256").update(text).digest("hex");
    const previous = keyed ? store.get(key) : undefined;
    const targetId = adapter.targetId;
    if (
      keyed &&
      (!targetId || targetId.length > 1000 || (previous && previous.targetId !== targetId))
    ) {
      return rejected(destination);
    }
    // Unresolved attempts quarantine changed text as well as repeated content.
    if (
      previous &&
      (previous.status === "uncertain" ||
        previous.status === "in-flight" ||
        previous.digest === digest)
    ) {
      return receipt(previous, true);
    }
    const record: MessageRecord = {
      targetId: targetId ?? destination,
      digest,
      deliveryId: randomUUID(),
      destination,
      status: "in-flight",
      externalId: previous?.externalId ?? null,
    };
    if (previous?.externalId && !adapter.update) return rejected(destination);
    if (keyed) store.set(key, record);
    try {
      const result = await callAdapterWithTimeout(
        adapter,
        record.externalId,
        text,
        options.timeoutMs,
      );
      record.status = result.status;
      if (result.status === "confirmed") {
        record.externalId = result.externalId ?? record.externalId;
        if (keyed && !record.externalId) record.status = "uncertain";
      }
    } catch {
      record.status = "uncertain";
    }
    if (keyed) store.set(key, record);
    return receipt(record, false);
  }

  return {
    async notify(input: NotificationBroadcast): Promise<NotificationBroadcastResult> {
      if (stopped) throw new Error("Notifications are stopped");
      const checked = NotificationBroadcastSchema.parse(input);
      const destinations = Object.entries(resolveDestinations(checked.scope));
      z.array(z.string().min(1).max(200))
        .min(1)
        .max(100)
        .parse(destinations.map(([name]) => name));
      if (pendingDeliveries + destinations.length > options.max)
        throw new Error("Notification capacity reached; wait for active attempts");
      pendingDeliveries += destinations.length;
      const deliveries = await Promise.all(
        destinations.map(([destination, adapter]) => {
          const key = JSON.stringify([
            checked.scope,
            checked.messageKey ?? randomUUID(),
            destination,
          ]);
          const previousTail = tails.get(key);
          const completion = (previousTail ?? Promise.resolve())
            .then(async () => {
              try {
                return await deliver(
                  key,
                  destination,
                  adapter,
                  checked.text,
                  checked.messageKey !== undefined,
                );
              } catch {
                return { ...rejected(destination), status: "uncertain" as const };
              }
            })
            .finally(() => {
              pendingDeliveries--;
              // An older completion must not remove a newer request's queue tail.
              if (tails.get(key) === completion) tails.delete(key);
            });
          tails.set(key, completion);
          return completion;
        }),
      );
      for (const delivery of deliveries) {
        receipts.delete(delivery.deliveryId);
        receipts.set(delivery.deliveryId, delivery);
        if (receipts.size > options.max) receipts.delete(receipts.keys().next().value!);
      }
      return { scope: checked.scope, messageKey: checked.messageKey, deliveries };
    },
    delivery: (deliveryId: string) => receipts.get(deliveryId),
    async stop() {
      stopped = true;
      await Promise.allSettled([...tails.values()]);
      store.close();
      receipts.clear();
    },
  };
}

/**
 * Bound an adapter call and release its timer regardless of the transport outcome.
 */
async function callAdapterWithTimeout(
  adapter: NotificationAdapter,
  externalId: string | null,
  text: string,
  timeoutMs: number,
): Promise<AdapterResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Notification timed out"));
    }, timeoutMs);
  });
  try {
    const operation = externalId
      ? adapter.update!(externalId, text, controller.signal)
      : adapter.send(text, controller.signal);
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep keys until shutdown rather than evicting handles and accidentally creating duplicates.
 */
function createMessageStore(max: number): MessageStore {
  const records = new Map<string, MessageRecord>();
  return {
    get: (key) => records.get(key),
    set(key, record) {
      if (!records.has(key) && records.size >= max)
        throw new Error("Notification message capacity reached");
      records.set(key, { ...record });
    },
    close: () => records.clear(),
  };
}

/**
 * Return safe channel metadata without leaking transport errors.
 */
function receipt(record: MessageRecord, duplicate: boolean): NotificationResult {
  return {
    deliveryId: record.deliveryId,
    destination: record.destination,
    status: record.status,
    externalId: record.externalId,
    duplicate,
  };
}

/**
 * Reject unsupported or unbound channels without affecting sibling deliveries.
 */
function rejected(destination: string): NotificationResult {
  return {
    deliveryId: randomUUID(),
    destination,
    status: "rejected",
    externalId: null,
    duplicate: false,
  };
}
