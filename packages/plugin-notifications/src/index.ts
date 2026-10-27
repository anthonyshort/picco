import * as z from "zod";
import { createDeliveries } from "./delivery.js";
import { createNotificationTool } from "./tool.js";
import { createMessages } from "./messages.js";
import { createPersistentMessageStore } from "./message-store.js";
import type {
  NotificationOptions,
  NotificationPlugin,
  NotificationInput,
  NotificationResult,
  NotificationBroadcast,
  NotificationBroadcastResult,
} from "./types.js";
export type {
  AdapterResult,
  NotificationAdapter,
  NotificationInput,
  NotificationOptions,
  NotificationPlugin,
  NotificationResult,
  NotificationBroadcast,
  NotificationBroadcastResult,
} from "./types.js";

/**
 * Track notifications through host-configured adapters and expose one notify tool.
 */
export function notifications(options: NotificationOptions): NotificationPlugin {
  const destinations = new Map(Object.entries(options.destinations));
  z.array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .parse([...destinations.keys()]);
  const limits = z
    .object({
      timeoutMs: z.number().int().min(1).max(60_000),
      max: z.number().int().min(1).max(100_000),
      retentionDays: z.number().int().min(1).max(3650),
    })
    .parse({
      timeoutMs: options.timeoutMs ?? 15_000,
      max: options.maxDeliveryRecords ?? 10_000,
      retentionDays: options.deliveryRetentionDays ?? 30,
    });
  let deliveries: ReturnType<typeof createDeliveries> | undefined;
  let messages: ReturnType<typeof createMessages> | undefined;

  function ensureDeliveries() {
    if (!deliveries) throw new Error("Notifications are not started");
    return deliveries;
  }

  function notify(input: NotificationInput): Promise<NotificationResult>;
  function notify(input: NotificationBroadcast): Promise<NotificationBroadcastResult>;
  function notify(input: NotificationInput | NotificationBroadcast) {
    ensureDeliveries();
    return "destination" in input ? deliveries!.notify(input) : messages!.notify(input);
  }

  const plugin: NotificationPlugin = {
    name: "notifications",
    tools: [],
    notify,
    delivery: (deliveryId) =>
      ensureDeliveries().delivery(deliveryId) ?? messages!.delivery(deliveryId),
    start(ctx) {
      const store = createPersistentMessageStore(
        options.messageStorePath ?? ctx.filePath("messages.sqlite"),
        limits.max,
      );
      deliveries = createDeliveries(destinations, {
        ...limits,
        ttl: limits.retentionDays * 86_400_000,
      });
      messages = createMessages(
        options.resolveDestinations ?? (() => options.destinations),
        {
          max: limits.max,
          timeoutMs: limits.timeoutMs,
        },
        store,
      );
    },
    async stop() {
      await Promise.all([deliveries?.stop(), messages?.stop()]);
      deliveries = undefined;
      messages = undefined;
    },
  };
  plugin.tools = [
    createNotificationTool([...destinations.keys()], plugin, (input) => plugin.notify(input)),
  ];
  return plugin;
}
