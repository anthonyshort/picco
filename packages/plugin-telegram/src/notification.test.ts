import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { notifications, type NotificationResult } from "../../plugin-notifications/src/index.js";
import { runReview } from "../../plugin-github-reviews/src/runner.js";
import { createReviewStore } from "../../plugin-github-reviews/src/store.js";
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

  test("sends review-start callbacks through the host notification API and Telegram adapter", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "picco-review-notification-"));
    const store = createReviewStore(path.join(directory, "reviews.sqlite"));
    store.reconcile("reviewer", [
      {
        repository: "example/project",
        number: 42,
        title: "Requested change",
        url: "https://github.com/example/project/pull/42",
        head: "a".repeat(40),
        createdAt: new Date().toISOString(),
      },
    ]);
    const selectedRun = store.admit(store.next()[0]!.id, "reviewer", 1)!;
    const ctx = createFakePluginContext({ source: "github-reviews" });
    const send = vi
      .spyOn(Api.prototype, "sendMessage")
      .mockResolvedValue(receipt(456, "Review starting"));
    const polling = vi.spyOn(Bot.prototype, "start");
    const deliveries: NotificationResult[] = [];
    const notifier = notifications({
      destinations: {
        telegram: telegramNotifications({ botToken: "123:test-token", chatId: 456 }),
      },
    });
    try {
      await notifier.start?.(ctx);
      await runReview({
        ctx,
        store,
        run: selectedRun,
        skill: "review",
        reviewsDirectory: directory,
        timeoutMs: 60_000,
        onRunStart: async ({ run }) => {
          const delivery = await notifier.notify({
            destination: "telegram",
            text: `Review starting: ${run.repository} #${run.number}\n${run.url}`,
            deduplicationKey: `review-start:${run.id}`,
          });
          deliveries.push(delivery);
          if (delivery.status !== "confirmed") throw new Error("Start notification unconfirmed");
        },
      }).completion;
      expect(deliveries).toMatchObject([{ status: "confirmed", externalId: "77" }]);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        456,
        "Review starting: example/project #42\nhttps://github.com/example/project/pull/42",
        { link_preview_options: { is_disabled: true } },
        expect.any(AbortSignal),
      );
      expect(polling).not.toHaveBeenCalled();
      expect(ctx.turns).toHaveLength(1);
    } finally {
      await notifier.stop?.();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
