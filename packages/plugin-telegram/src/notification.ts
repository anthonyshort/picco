import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { GrammyError } from "grammy";
import { tool, type Tool } from "@picco-agent/core";
import * as z from "zod";
import { TELEGRAM_MAX } from "./limits.js";

/**
 * A caller-supplied key identifies one notification intent, not a conversation.
 */
export const NotificationInputSchema = z
  .object({
    text: z.string().trim().min(1).max(TELEGRAM_MAX),
    deduplicationKey: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Arguments shared by host notifications and the model tool.
 */
export type NotificationInput = z.infer<typeof NotificationInputSchema>;

/**
 * Delivery states shared by active attempts and cached receipts.
 */
const DELIVERY_STATUSES = ["in-flight", "confirmed", "rejected", "uncertain"] as const;

/**
 * Cached metadata excludes message text and credentials.
 */
interface Delivery {
  deliveryId: string;
  digest: string;
  status: (typeof DELIVERY_STATUSES)[number];
  messageId: number | null;
}

/**
 * Public delivery evidence never includes text, a token or the payload digest.
 */
export type NotificationResult = Omit<Delivery, "digest"> & { duplicate: boolean };

/**
 * Bound completed receipts and active attempts separately; TTL begins on completion.
 */
interface NotificationCacheOptions {
  max: number;
  ttl: number;
}

/**
 * The transport accepts cancellation and returns Telegram's receipt.
 */
export type NotificationSender = (
  chatId: number,
  text: string,
  signal: AbortSignal,
) => Promise<{ message_id: number }>;

/**
 * Share bounded process-local deduplication between host callbacks and model tools.
 */
export function createNotifications(
  chatId: number,
  send: NotificationSender,
  timeoutMs: number,
  options: NotificationCacheOptions,
) {
  const cache = new LRUCache<string, Delivery>({ max: options.max, ttl: options.ttl });
  const active = new Map<string, { delivery: Delivery; completion: Promise<NotificationResult> }>();
  let stopped = false;

  async function deliver(delivery: Delivery, text: string): Promise<NotificationResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Notification send timed out"));
      }, timeoutMs);
    });
    try {
      const receipt = await Promise.race([send(chatId, text, controller.signal), timeout]);
      delivery.status = "confirmed";
      delivery.messageId = receipt.message_id;
    } catch (err) {
      delivery.status = err instanceof GrammyError ? "rejected" : "uncertain";
    } finally {
      clearTimeout(timer);
    }
    return result(delivery, false);
  }

  return {
    async notify(input: NotificationInput): Promise<NotificationResult> {
      if (stopped) throw new Error("Telegram notifications are stopped");
      const { text, deduplicationKey } = NotificationInputSchema.parse(input);
      const key = deduplicationKey === undefined ? `id:${randomUUID()}` : `key:${deduplicationKey}`;
      const digest = createHash("sha256").update(text).digest("hex");
      const previous = active.get(key)?.delivery ?? cache.get(key);
      if (previous) {
        if (previous.digest !== digest)
          throw new Error("Telegram notification key was already used for different content");
        return result(previous, true);
      }
      if (active.size >= options.max)
        throw new Error("Telegram notification capacity reached; wait for active attempts");
      const delivery: Delivery = {
        deliveryId: randomUUID(),
        digest,
        status: "in-flight",
        messageId: null,
      };
      const completion = Promise.resolve().then(async () => {
        try {
          return await deliver(delivery, text);
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
 * Build the notification tool around the same host delivery service.
 */
export function createNotificationTool(
  notifications: () => Pick<ReturnType<typeof createNotifications>, "notify">,
): Tool {
  return tool({
    name: "telegram_notify",
    description:
      "Send one plain-text notification to the configured chat. Reuse a deduplicationKey for the same intent. Inspect uncertain delivery; never retry it automatically. Use reply for conversation responses.",
    input: NotificationInputSchema,
    async execute(input, ctx) {
      const delivery = await notifications().notify(input);
      ctx.logger.log("notification delivery", {
        executionId: ctx.execution?.id,
        deliveryId: delivery.deliveryId,
        status: delivery.status,
        duplicate: delivery.duplicate,
      });
      return JSON.stringify(delivery);
    },
  });
}

/**
 * Inspect notification evidence without attempting delivery.
 */
export function createDeliveryTool(
  notifications: () => Pick<ReturnType<typeof createNotifications>, "delivery">,
): Tool {
  return tool({
    name: "telegram_delivery",
    description: "Inspect cached delivery evidence by deliveryId without sending a message.",
    input: z.object({ deliveryId: z.uuid() }).strict(),
    execute({ deliveryId }) {
      return JSON.stringify(notifications().delivery(deliveryId) ?? { found: false });
    },
  });
}

/**
 * Limit user-visible output to safe receipt metadata.
 */
function result(delivery: Delivery, duplicate: boolean): NotificationResult {
  return {
    deliveryId: delivery.deliveryId,
    status: delivery.status,
    messageId: delivery.messageId,
    duplicate,
  };
}
