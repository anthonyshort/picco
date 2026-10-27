import { createHash, randomUUID } from "node:crypto";
import * as z from "zod";
import PQueue from "p-queue";
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
  set(key: string, record: MessageRecord, expectedDeliveryId: string | null): void;
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
 * Mutable queue ownership shared by accepted broadcasts and shutdown.
 */
interface MessageQueue {
  channels: Map<string, PQueue>;
  receipts: Map<string, NotificationResult>;
  pendingDeliveries: number;
  stopped: boolean;
}

/**
 * One resolved channel operation, including its scoped message identity.
 */
interface ChannelRequest {
  key: string;
  destination: string;
  adapter: NotificationAdapter;
  text: string;
  keyed: boolean;
}

/**
 * Preparation either returns an existing/refused receipt or a new attempt to reserve.
 */
type MessagePreparation = { result: NotificationResult } | { record: MessageRecord };

/**
 * Broadcast independently and serialise edits to each scoped channel message.
 */
export function createMessages(
  resolveDestinations: (scope: string) => Record<string, NotificationAdapter>,
  options: MessageOptions,
  store: MessageStore = createMessageStore(options.max),
) {
  const queue: MessageQueue = {
    channels: new Map(),
    receipts: new Map(),
    pendingDeliveries: 0,
    stopped: false,
  };
  return {
    notify: (input: NotificationBroadcast) =>
      broadcastMessage(input, resolveDestinations, queue, options, store),
    delivery: (deliveryId: string) => queue.receipts.get(deliveryId),
    async stop() {
      queue.stopped = true;
      await Promise.all([...queue.channels.values()].map((channel) => channel.onIdle()));
      store.close();
      queue.receipts.clear();
    },
  };
}

/**
 * Reserve the entire broadcast before registering any asynchronous channel work.
 */
async function broadcastMessage(
  input: NotificationBroadcast,
  resolveDestinations: (scope: string) => Record<string, NotificationAdapter>,
  queue: MessageQueue,
  options: MessageOptions,
  store: MessageStore,
): Promise<NotificationBroadcastResult> {
  if (queue.stopped) {
    throw new Error("Notifications are stopped");
  }
  const checked = NotificationBroadcastSchema.parse(input);
  const channels = resolveChannels(resolveDestinations, checked.scope);
  reserveBatchCapacity(queue, channels.length, options.max);
  const pending = channels.map((channel) =>
    enqueueMessage(createChannelRequest(channel, checked), queue, store, options.timeoutMs),
  );
  const deliveries = await Promise.all(pending);
  rememberReceipts(queue.receipts, deliveries, options.max);
  return { scope: checked.scope, messageKey: checked.messageKey, deliveries };
}

/**
 * Validate host-resolved channel names before reserving capacity or invoking adapters.
 */
function resolveChannels(
  resolveDestinations: (scope: string) => Record<string, NotificationAdapter>,
  scope: string,
): [string, NotificationAdapter][] {
  const channels = Object.entries(resolveDestinations(scope));
  z.array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .parse(channels.map(([name]) => name));
  return channels;
}

/**
 * Count queued channel deliveries rather than broadcasts or cached receipts.
 */
function reserveBatchCapacity(queue: MessageQueue, count: number, max: number): void {
  if (queue.pendingDeliveries + count > max) {
    throw new Error("Notification capacity reached; wait for active attempts");
  }
  queue.pendingDeliveries += count;
}

/**
 * Unkeyed broadcasts receive fresh channel identities on every call.
 */
function createChannelRequest(
  [destination, adapter]: [string, NotificationAdapter],
  input: NotificationBroadcast,
): ChannelRequest {
  return {
    key: JSON.stringify([input.scope, input.messageKey ?? randomUUID(), destination]),
    destination,
    adapter,
    text: input.text,
    keyed: input.messageKey !== undefined,
  };
}

/**
 * Each scoped channel has its own FIFO so unrelated messages can run concurrently.
 */
function enqueueMessage(
  request: ChannelRequest,
  queue: MessageQueue,
  store: MessageStore,
  timeoutMs: number,
): Promise<NotificationResult> {
  const channel = queue.channels.get(request.key) ?? createChannelQueue(queue, request.key);
  return channel.add(() => runQueuedDelivery(request, queue, store, timeoutMs));
}

/**
 * Remove an idle channel without depending on add() promise-settlement timing.
 */
function createChannelQueue(queue: MessageQueue, key: string): PQueue {
  const channel = new PQueue({ concurrency: 1 });
  queue.channels.set(key, channel);
  channel.addEventListener(
    "idle",
    () => {
      if (channel.size === 0 && channel.pending === 0 && queue.channels.get(key) === channel) {
        queue.channels.delete(key);
      }
    },
    { once: true },
  );
  return channel;
}

/**
 * Keep channel failures independent and release each accepted capacity reservation once.
 */
async function runQueuedDelivery(
  request: ChannelRequest,
  queue: MessageQueue,
  store: MessageStore,
  timeoutMs: number,
): Promise<NotificationResult> {
  // Register every channel before an adapter can synchronously re-enter the host.
  await Promise.resolve();
  try {
    return await deliverMessage(request, store, timeoutMs);
  } catch {
    return rejected(request.destination);
  } finally {
    queue.pendingDeliveries--;
  }
}

/**
 * Keep preparation, reservation, invocation and confirmation in effect order.
 */
async function deliverMessage(
  request: ChannelRequest,
  store: MessageStore,
  timeoutMs: number,
): Promise<NotificationResult> {
  const previous = request.keyed ? store.get(request.key) : undefined;
  const preparation = prepareMessage(request, previous);
  if ("result" in preparation) {
    return preparation.result;
  }
  const record = preparation.record;
  if (request.keyed) {
    store.set(request.key, record, previous?.deliveryId ?? null);
  }
  await invokeAdapter(request, record, timeoutMs);
  try {
    if (request.keyed) {
      store.set(request.key, record, record.deliveryId);
    }
  } catch {
    record.status = "uncertain";
  }
  return receipt(record, false);
}

/**
 * Decide whether the bound recipient can reuse or update an existing message.
 */
function prepareMessage(
  request: ChannelRequest,
  previous: MessageRecord | undefined,
): MessagePreparation {
  const digest = createHash("sha256").update(request.text).digest("hex");
  const targetId = request.adapter.targetId;
  if (
    request.keyed &&
    (!targetId || targetId.length > 1000 || (previous && previous.targetId !== targetId))
  ) {
    return { result: rejected(request.destination) };
  }
  // Unresolved attempts quarantine changed text as well as repeated content.
  if (
    previous &&
    (previous.status === "uncertain" ||
      previous.status === "in-flight" ||
      previous.digest === digest)
  ) {
    return { result: receipt(previous, true) };
  }
  const record: MessageRecord = {
    targetId: targetId ?? request.destination,
    digest,
    deliveryId: randomUUID(),
    destination: request.destination,
    status: "in-flight",
    externalId: previous?.externalId ?? null,
  };
  if (previous?.externalId && !request.adapter.update) {
    return { result: rejected(request.destination) };
  }
  return { record };
}

/**
 * Apply transport results without swallowing reservation or confirmation-store failures.
 */
async function invokeAdapter(
  request: ChannelRequest,
  record: MessageRecord,
  timeoutMs: number,
): Promise<void> {
  try {
    const result = await callAdapterWithTimeout(
      request.adapter,
      record.externalId,
      request.text,
      timeoutMs,
    );
    applyAdapterResult(record, result, request.keyed);
  } catch {
    record.status = "uncertain";
  }
}

/**
 * A keyed success needs a provider ID before future edits can safely address it.
 */
function applyAdapterResult(record: MessageRecord, result: AdapterResult, keyed: boolean): void {
  record.status = result.status;
  if (result.status === "confirmed") {
    record.externalId = result.externalId ?? record.externalId;
    if (keyed && !record.externalId) {
      record.status = "uncertain";
    }
  }
}

/**
 * Bound receipt inspection independently of retained editable-message handles.
 */
function rememberReceipts(
  receipts: Map<string, NotificationResult>,
  deliveries: NotificationResult[],
  max: number,
): void {
  for (const delivery of deliveries) {
    receipts.delete(delivery.deliveryId);
    receipts.set(delivery.deliveryId, delivery);
    if (receipts.size > max) {
      receipts.delete(receipts.keys().next().value!);
    }
  }
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
    set(key, record, expectedDeliveryId) {
      if ((records.get(key)?.deliveryId ?? null) !== expectedDeliveryId) {
        throw new Error("Notification reservation changed");
      }
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
