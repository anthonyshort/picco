import { Api, GrammyError } from "grammy";
import * as z from "zod";
import type { NotificationAdapter } from "@picco-agent/plugin-notifications";
import { TELEGRAM_MAX } from "./limits.js";

/**
 * One fixed Telegram recipient, independent of the conversational gateway and its allowlist.
 */
export interface TelegramNotificationOptions {
  botToken: string;
  chatId: number;
}

/**
 * Send plain-text notifications without starting a polling bot or registering another tool.
 */
export function telegramNotifications(options: TelegramNotificationOptions): NotificationAdapter {
  const chatId = z
    .number()
    .int()
    .safe()
    .refine((value) => value !== 0)
    .parse(options.chatId);
  const api = new Api(options.botToken);
  return {
    async send(text, signal) {
      if (text.length > TELEGRAM_MAX) return { status: "rejected" };
      try {
        // grammY declares a legacy EventTarget shim; its transport accepts native signals.
        const receipt = await api.sendMessage(
          chatId,
          text,
          { link_preview_options: { is_disabled: true } },
          signal as Parameters<Api["sendMessage"]>[3],
        );
        return { status: "confirmed", externalId: String(receipt.message_id) };
      } catch (err) {
        if (err instanceof GrammyError) return { status: "rejected" };
        throw err;
      }
    },
  };
}
