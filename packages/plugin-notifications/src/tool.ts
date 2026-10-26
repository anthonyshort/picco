import * as z from "zod";
import { tool, type Tool } from "@picco-agent/core";
import { NotificationInputSchema } from "./types.js";
import type { NotificationPlugin } from "./types.js";

/**
 * Send and inspect through one tool with a provider-compatible object input schema.
 */
export function createNotificationTool(
  destinations: string[],
  notifications: Pick<NotificationPlugin, "notify" | "delivery">,
): Tool {
  const inputSchema = z
    .object({
      action: z.enum(["send", "status"]),
      destination: z.enum(destinations).optional(),
      text: NotificationInputSchema.shape.text.optional(),
      deduplicationKey: NotificationInputSchema.shape.deduplicationKey,
      deliveryId: z.uuid().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "send") {
        if (!value.destination)
          ctx.addIssue({ code: "custom", path: ["destination"], message: "Required for send" });
        if (!value.text)
          ctx.addIssue({ code: "custom", path: ["text"], message: "Required for send" });
        if (value.deliveryId !== undefined)
          ctx.addIssue({ code: "custom", path: ["deliveryId"], message: "Only used for status" });
      } else {
        if (!value.deliveryId)
          ctx.addIssue({ code: "custom", path: ["deliveryId"], message: "Required for status" });
        for (const field of ["destination", "text", "deduplicationKey"] as const) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: "Only used for send" });
        }
      }
    });
  return tool({
    name: "notify",
    description:
      "Send a plain-text notification to a configured destination with action=send, destination and text. Reuse a deduplicationKey for the same intent. Inspect a receipt with action=status and deliveryId; never automatically retry uncertain delivery. Use reply for conversation responses.",
    input: inputSchema,
    async execute(input, ctx) {
      switch (input.action) {
        case "send": {
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
