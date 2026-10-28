import * as z from "zod";
import { tool, type Tool } from "@picco-agent/core";
import { NotificationInputSchema, NotificationBroadcastSchema } from "./types.js";
import type { createDeliveries } from "./delivery.js";
import type { NotificationBroadcast, NotificationBroadcastResult } from "./types.js";

/**
 * Send and inspect through one tool with a provider-compatible object input schema.
 */
export function createNotificationTool(
  destinations: string[],
  notifications: Pick<ReturnType<typeof createDeliveries>, "notify" | "delivery">,
  broadcast?: (input: NotificationBroadcast) => Promise<NotificationBroadcastResult>,
): Tool {
  const inputSchema = z
    .object({
      action: z.enum(["send", "status"]),
      destination: z.enum(destinations).optional(),
      text: NotificationInputSchema.shape.text.optional(),
      deduplicationKey: NotificationInputSchema.shape.deduplicationKey,
      messageKey: NotificationBroadcastSchema.shape.messageKey,
      deliveryId: z.uuid().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "send") {
        if (!value.destination && !broadcast)
          ctx.addIssue({ code: "custom", path: ["destination"], message: "Required for send" });
        if (!value.text)
          ctx.addIssue({ code: "custom", path: ["text"], message: "Required for send" });
        if (value.deliveryId !== undefined)
          ctx.addIssue({ code: "custom", path: ["deliveryId"], message: "Only used for status" });
        if (value.destination && value.messageKey !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["messageKey"],
            message: "Only used for broadcasts",
          });
        if (!value.destination && value.deduplicationKey !== undefined)
          ctx.addIssue({
            code: "custom",
            path: ["deduplicationKey"],
            message: "Use messageKey for broadcasts",
          });
      } else {
        if (!value.deliveryId)
          ctx.addIssue({ code: "custom", path: ["deliveryId"], message: "Required for status" });
        for (const field of ["destination", "text", "deduplicationKey", "messageKey"] as const) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: "Only used for send" });
        }
      }
    });
  return tool({
    name: "notify",
    description:
      "Send a notification with action=send and text. Omit destination to broadcast to host-bound channels; reuse messageKey to update the same messages in this session. For a directed send, supply destination and optionally deduplicationKey. Inspect a receipt with action=status and deliveryId; never automatically retry uncertain delivery. Use reply for conversation responses.",
    input: inputSchema,
    async execute(input, ctx) {
      switch (input.action) {
        case "send": {
          if (!input.destination && broadcast) {
            const scope =
              ctx.caller.kind === "session"
                ? JSON.stringify(["session", ctx.caller.ref.source, ctx.caller.ref.key])
                : JSON.stringify(["host"]);
            return JSON.stringify(
              await broadcast(
                NotificationBroadcastSchema.parse({
                  scope,
                  messageKey: input.messageKey,
                  text: input.text,
                }),
              ),
            );
          }
          const delivery = await notifications.notify(
            NotificationInputSchema.parse({
              destination: input.destination,
              text: input.text,
              deduplicationKey: input.deduplicationKey,
            }),
          );
          ctx.logger.log("notification delivery", {
            executionId: ctx.execution?.id,
            deliveryId: delivery.deliveryId,
            destination: delivery.destination,
            status: delivery.status,
            duplicate: delivery.duplicate,
          });
          return JSON.stringify(delivery);
        }
        case "status":
          return JSON.stringify(
            notifications.delivery(z.uuid().parse(input.deliveryId)) ?? { found: false },
          );
        default:
          throw new Error("Unknown notification action");
      }
    },
  });
}
