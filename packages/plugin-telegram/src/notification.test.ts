import { describe, expect, test } from "vitest";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { telegram } from "./index.js";
import { createNotificationTool } from "./notification.js";

const ctx: ToolContext = {
  caller: { kind: "session", ref: { source: "cron", key: "example" } },
  logger: silentLogger(),
};

describe("Telegram notifications", () => {
  test("registers only for a configured allowlisted recipient", () => {
    expect(telegram({ botToken: "123:test-token", allowlist: [456] }).tools).toEqual([]);
    expect(
      telegram({
        botToken: "123:test-token",
        allowlist: [456],
        notificationChatId: 456,
      }).tools?.map((entry) => entry.name),
    ).toEqual(["telegram_notify"]);
    for (const notificationChatId of [0, 1.5, 999, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        telegram({ botToken: "123:test-token", allowlist: [456], notificationChatId }),
      ).toThrow("notificationChatId");
    }
  });

  test("sends exactly once to the fixed chat and accepts no recipient override", async () => {
    const calls: { chatId: number; text: string }[] = [];
    const notification = createNotificationTool(456, async (chatId, text) => {
      calls.push({ chatId, text });
    });
    expect(notification.input.safeParse({ text: "hello", chatId: 999 }).success).toBe(false);
    expect(notification.input.safeParse({ text: "   " }).success).toBe(false);
    expect(notification.input.safeParse({ text: "x".repeat(4097) }).success).toBe(false);
    const result = await notification.execute(
      notification.input.parse({ text: "  **Ready**  " }),
      ctx,
    );
    expect(calls).toEqual([{ chatId: 456, text: "**Ready**" }]);
    expect(result).toContain("confirmed");
  });

  test("does not retry uncertain sends or expose a credential-bearing error", async () => {
    let attempts = 0;
    const notification = createNotificationTool(456, async () => {
      attempts++;
      throw new Error("https://api.telegram.org/bot123:private-token/sendMessage");
    });
    await expect(
      notification.execute(notification.input.parse({ text: "Ready" }), ctx),
    ).rejects.toThrow(
      /^Telegram notification delivery was not confirmed\. Do not retry automatically\.$/,
    );
    expect(attempts).toBe(1);
  });
});
