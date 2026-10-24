import { tool, type Tool } from "@picco-agent/core";
import * as z from "zod";
import { TELEGRAM_MAX } from "./limits.js";

/**
 * Build a notification tool whose recipient is configured outside the model's input.
 */
export function createNotificationTool(
  chatId: number,
  send: (chatId: number, text: string) => Promise<unknown>,
): Tool {
  return tool({
    name: "telegram_notify",
    description:
      "Send one plain-text notification to the configured Telegram chat. Use reply for conversation responses. Do not retry delivery that was not confirmed.",
    input: z.object({ text: z.string().trim().min(1).max(TELEGRAM_MAX) }).strict(),
    async execute({ text }) {
      try {
        await send(chatId, text);
      } catch {
        throw new Error(
          "Telegram notification delivery was not confirmed. Do not retry automatically.",
        );
      }
      return "Telegram confirmed notification delivery.";
    },
  });
}
