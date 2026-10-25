import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { GrammyError } from "grammy";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { telegram } from "./index.js";
import { DeliveryStore } from "./delivery-store.js";
import {
  createNotificationTool,
  createNotifications,
  type NotificationSender,
} from "./notification.js";

/**
 * Tool callers cannot change the configured recipient.
 */
const ctx: ToolContext = {
  caller: { kind: "session", ref: { source: "cron", key: "example" } },
  logger: silentLogger(),
};

/**
 * Use the production ledger with an injected transport.
 */
function fixture(send: NotificationSender, timeoutMs = 1000) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "telegram-notify-"));
  const store = new DeliveryStore(path.join(directory, "deliveries.sqlite"), {
    maxRecords: 10,
    retentionMs: 1000,
  });
  const notifications = createNotifications(456, store, send, timeoutMs);
  return {
    notifications,
    tool: createNotificationTool(() => notifications),
    async close() {
      await notifications.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Telegram notifications", () => {
  test("registers delivery tools only for a configured allowlisted recipient", () => {
    expect(telegram({ botToken: "123:test-token", allowlist: [456] }).tools).toEqual([]);
    expect(
      telegram({
        botToken: "123:test-token",
        allowlist: [456],
        notificationChatId: 456,
      }).tools?.map((entry) => entry.name),
    ).toEqual(["telegram_notify", "telegram_delivery"]);
    for (const notificationChatId of [0, 1.5, 999, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        telegram({ botToken: "123:test-token", allowlist: [456], notificationChatId }),
      ).toThrow("notificationChatId");
    }
  });

  test("records a fixed-recipient receipt and rejects invalid inputs", async () => {
    const calls: { chatId: number; text: string }[] = [];
    const f = fixture(async (chatId, text) => {
      calls.push({ chatId, text });
      return { message_id: 77 };
    });
    try {
      expect(f.tool.input.safeParse({ text: "hello", chatId: 999 }).success).toBe(false);
      expect(f.tool.input.safeParse({ text: "   " }).success).toBe(false);
      expect(f.tool.input.safeParse({ text: "x".repeat(4097) }).success).toBe(false);
      const result = JSON.parse(
        String(await f.tool.execute(f.tool.input.parse({ text: "  **Ready**  " }), ctx)),
      );
      expect(result).toMatchObject({ status: "confirmed", messageId: 77, duplicate: false });
      expect(calls).toEqual([{ chatId: 456, text: "**Ready**" }]);
      expect(f.notifications.delivery(result.deliveryId)).toMatchObject({
        status: "confirmed",
        messageId: 77,
      });
    } finally {
      await f.close();
    }
  });

  test("concurrent calls reserve a keyed intent once before transport and conflict on changed text", async () => {
    const receipt = Promise.withResolvers<{ message_id: number }>();
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return receipt.promise;
    });
    try {
      const first = f.notifications.notify({ text: "Ready", deduplicationKey: "complete" });
      const duplicate = await f.notifications.notify({
        text: "Ready",
        deduplicationKey: "complete",
      });
      expect(duplicate).toMatchObject({ status: "in-flight", duplicate: true });
      await expect(
        f.notifications.notify({ text: "Changed", deduplicationKey: "complete" }),
      ).rejects.toThrow("different content");
      receipt.resolve({ message_id: 12 });
      expect(await first).toMatchObject({ status: "confirmed", deliveryId: duplicate.deliveryId });
      expect(calls).toBe(1);
    } finally {
      receipt.resolve({ message_id: 12 });
      await f.close();
    }
  });

  test("network uncertainty is retained without exposing or retrying credential-bearing errors", async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      throw new Error("https://api.telegram.org/bot123:private-token/sendMessage");
    });
    try {
      const first = await f.notifications.notify({ text: "Ready", deduplicationKey: "one" });
      expect(first.status).toBe("uncertain");
      expect(JSON.stringify(first)).not.toContain("private-token");
      expect(
        await f.notifications.notify({ text: "Ready", deduplicationKey: "one" }),
      ).toMatchObject({ status: "uncertain", duplicate: true });
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("a definite Telegram rejection is distinct from uncertainty", async () => {
    const f = fixture(async () => {
      throw new GrammyError(
        "send",
        { ok: false, error_code: 403, description: "private" },
        "sendMessage",
        {},
      );
    });
    try {
      expect(await f.notifications.notify({ text: "Ready" })).toMatchObject({ status: "rejected" });
    } finally {
      await f.close();
    }
  });

  test("timeout aborts the transport and shutdown waits for bounded send completion", async () => {
    let signal: AbortSignal | undefined;
    const f = fixture(async (_chatId, _text, attemptSignal) => {
      signal = attemptSignal;
      return new Promise(() => {});
    }, 5);
    const result = f.notifications.notify({ text: "Ready", deduplicationKey: "one" });
    await f.close();
    expect(await result).toMatchObject({ status: "uncertain" });
    expect(signal?.aborted).toBe(true);
    await expect(f.notifications.notify({ text: "Later" })).rejects.toThrow("stopped");
  });
});
