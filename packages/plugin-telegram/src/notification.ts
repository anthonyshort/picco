import { createHash } from "node:crypto";
import { GrammyError } from "grammy";
import { tool, type Tool } from "@picco-agent/core";
import * as z from "zod";
import type { Delivery, DeliveryStore } from "./delivery-store.js";
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
 * Public delivery evidence never includes text, a token or the payload digest.
 */
export type NotificationResult = Pick<Delivery, "deliveryId" | "status" | "messageId"> & {
  duplicate: boolean;
};

/**
 * The transport accepts cancellation and returns Telegram's receipt.
 */
export type NotificationSender = (
  chatId: number,
  text: string,
  signal: AbortSignal,
) => Promise<{ message_id: number }>;

/**
 * Share durable delivery semantics between host callbacks and model tools.
 */
export function createNotifications(
  chatId: number,
  store: DeliveryStore,
  send: NotificationSender,
  timeoutMs: number,
) {
  const active = new Set<Promise<NotificationResult>>();
  let stopped = false;
  async function deliver(
    input: NotificationInput,
    executionId?: string,
  ): Promise<NotificationResult> {
    const { text, deduplicationKey } = NotificationInputSchema.parse(input);
    const { delivery, duplicate } = store.reserve(
      chatId,
      createHash("sha256").update(text).digest("hex"),
      deduplicationKey,
      executionId,
    );
    if (duplicate) return result(delivery, true);
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
      return result(store.finish(delivery.deliveryId, "confirmed", receipt.message_id), false);
    } catch (err) {
      const status = err instanceof GrammyError ? "rejected" : "uncertain";
      return result(store.finish(delivery.deliveryId, status), false);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    notify(input: NotificationInput, executionId?: string): Promise<NotificationResult> {
      if (stopped) return Promise.reject(new Error("Telegram notifications are stopped"));
      const operation = deliver(input, executionId);
      active.add(operation);
      void operation.finally(() => active.delete(operation)).catch(() => {});
      return operation;
    },
    delivery(deliveryId: string): NotificationResult | undefined {
      const delivery = store.get(deliveryId);
      return delivery?.recipient === chatId ? result(delivery, true) : undefined;
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.allSettled(active);
      store.close();
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
      const delivery = await notifications().notify(input, ctx.execution?.id);
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
    description: "Inspect retained delivery evidence by deliveryId without sending a message.",
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
