import { Api, GrammyError } from "grammy";
import * as z from "zod";
import type { NotificationAdapter } from "@picco-agent/plugin-notifications";
import { TELEGRAM_MAX } from "./limits.js";

/**
 * Telegram returns this rejection when an idempotent edit already matches its message.
 */
const MESSAGE_NOT_MODIFIED =
  "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message";

/**
 * Only canonical, positive message identifiers are accepted for edits.
 */
const MessageIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

/**
 * One fixed Telegram recipient, independent of the conversational gateway and its allowlist.
 */
export interface TelegramNotificationOptions {
  botToken: string;
  chatId: number;
}

/**
 * Send and edit plain-text notifications without starting a polling bot or registering another
 * tool.
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
    targetId: `telegram:${chatId}`,
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
    async update(externalId, text, signal) {
      const message = MessageIdSchema.safeParse(externalId);
      if (!message.success || text.length > TELEGRAM_MAX) return { status: "rejected" };
      try {
        await api.editMessageText(
          chatId,
          message.data,
          text,
          { link_preview_options: { is_disabled: true } },
          signal as Parameters<Api["editMessageText"]>[4],
        );
        return { status: "confirmed", externalId };
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 400 && err.description === MESSAGE_NOT_MODIFIED)
            return { status: "confirmed", externalId };
          return { status: "rejected" };
        }
        throw err;
      }
    },
  };
}
