import { afterEach, describe, expect, test, vi } from "vitest";
import { Api, Bot, GrammyError } from "grammy";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { telegram } from "./index.js";
import { telegramNotifications } from "./notification.js";

/**
 * A complete provider response for the HTTP boundary stand-in.
 */
function receipt(chatId: number, text: string) {
  return {
    message_id: 77,
    date: 0,
    chat: { id: chatId, type: "private" as const, first_name: "Test" },
    text,
  };
}

describe("Telegram notification adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  test("sends to a fixed recipient with cancellation without starting a polling bot", async () => {
    const polling = vi.spyOn(Bot.prototype, "start");
    const send = vi.spyOn(Api.prototype, "sendMessage").mockResolvedValue(receipt(456, "Ready"));
    const adapter = telegramNotifications({ botToken: "123:test-token", chatId: 456 });
    const signal = new AbortController().signal;
    expect(await adapter.send("Ready", signal)).toEqual({ status: "confirmed", externalId: "77" });
    expect(send).toHaveBeenCalledWith(
      456,
      "Ready",
      { link_preview_options: { is_disabled: true } },
      signal,
    );
    expect(polling).not.toHaveBeenCalled();
  });

  test("validates the recipient and rejects oversized messages before transport", async () => {
    for (const chatId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => telegramNotifications({ botToken: "123:test-token", chatId })).toThrow();
    const send = vi.spyOn(Api.prototype, "sendMessage").mockResolvedValue(receipt(456, "Ready"));
    const adapter = telegramNotifications({ botToken: "123:test-token", chatId: 456 });
    expect(await adapter.send("x".repeat(4097), new AbortController().signal)).toEqual({
      status: "rejected",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("distinguishes a definite Telegram rejection from a network failure", async () => {
    const send = vi.spyOn(Api.prototype, "sendMessage");
    const adapter = telegramNotifications({ botToken: "123:test-token", chatId: 456 });
    send.mockRejectedValueOnce(
      new GrammyError(
        "send",
        { ok: false, error_code: 403, description: "private" },
        "sendMessage",
        {},
      ),
    );
    expect(await adapter.send("Ready", new AbortController().signal)).toEqual({
      status: "rejected",
    });
    send.mockRejectedValueOnce(new Error("private-token"));
    await expect(adapter.send("Ready", new AbortController().signal)).rejects.toThrow(
      "private-token",
    );
  });

  test("keeps conversational polling defaults and contributes no notification tools", async () => {
    const bots: Bot[] = [];
    vi.spyOn(Bot.prototype, "start").mockImplementation(function (this: Bot) {
      bots.push(this);
      return new Promise<void>(() => {});
    });
    vi.spyOn(Bot.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(Api.prototype, "setMyCommands").mockResolvedValue(true);
    const gateway = telegram({ botToken: "123:test-token", allowlist: [456] });
    try {
      await gateway.start?.(createFakePluginContext({ source: "telegram" }));
      expect(bots).toHaveLength(1);
      expect(bots[0].api.options?.timeoutSeconds).toBeUndefined();
      expect(gateway.tools ?? []).toEqual([]);
    } finally {
      await gateway.stop?.();
    }
  });
});
