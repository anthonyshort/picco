import { afterEach, describe, expect, test, vi } from "vitest";
import { GrammyError } from "grammy";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { telegram } from "./index.js";
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
 * Exercise the real bounded cache with an injected transport.
 */
function fixture(send: NotificationSender, timeoutMs = 1000, options = { max: 10, ttl: 1000 }) {
  const notifications = createNotifications(456, send, timeoutMs, options);
  return {
    notifications,
    tool: createNotificationTool(() => notifications),
    close: () => notifications.stop(),
  };
}

/**
 * Keep lru-cache's captured performance clock aligned with fake transport timers.
 */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let timestamp = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => timestamp);
  return async (duration: number) => {
    timestamp += duration;
    await vi.advanceTimersByTimeAsync(duration);
  };
}

describe("Telegram notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
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

  test("cache eviction bounds receipts and permits an evicted intent to send again", async () => {
    let calls = 0;
    const f = fixture(async () => ({ message_id: ++calls }), 1000, { max: 2, ttl: 1000 });
    try {
      const first = await f.notifications.notify({ text: "First", deduplicationKey: "first" });
      const second = await f.notifications.notify({ text: "Second", deduplicationKey: "second" });
      await f.notifications.notify({ text: "First", deduplicationKey: "first" });
      const third = await f.notifications.notify({ text: "Third", deduplicationKey: "third" });
      expect(f.notifications.delivery(first.deliveryId)?.status).toBe("confirmed");
      expect(f.notifications.delivery(second.deliveryId)).toBeUndefined();
      expect(f.notifications.delivery(third.deliveryId)?.status).toBe("confirmed");
      const repeated = await f.notifications.notify({ text: "Second", deduplicationKey: "second" });
      expect(repeated.duplicate).toBe(false);
      expect(repeated.deliveryId).not.toBe(second.deliveryId);
      expect(calls).toBe(4);
    } finally {
      await f.close();
    }
  });

  test("receipt TTL starts on completion and duplicate reads do not renew it", async () => {
    const advance = fakeClock();
    const receipt = Promise.withResolvers<{ message_id: number }>();
    let calls = 0;
    const f = fixture(
      async () => {
        calls++;
        return receipt.promise;
      },
      10_000,
      { max: 2, ttl: 1000 },
    );
    try {
      const pending = f.notifications.notify({ text: "First", deduplicationKey: "first" });
      await advance(2000);
      receipt.resolve({ message_id: 7 });
      const first = await pending;
      await advance(600);
      expect(
        await f.notifications.notify({ text: "First", deduplicationKey: "first" }),
      ).toMatchObject({ duplicate: true, deliveryId: first.deliveryId });
      await advance(401);
      expect(f.notifications.delivery(first.deliveryId)).toBeUndefined();
      expect(
        await f.notifications.notify({ text: "First", deduplicationKey: "first" }),
      ).toMatchObject({ duplicate: false });
      expect(calls).toBe(2);
    } finally {
      receipt.resolve({ message_id: 7 });
      await f.close();
    }
  });

  test("active reservations survive cache expiry and capacity pressure", async () => {
    const advance = fakeClock();
    const receipt = Promise.withResolvers<{ message_id: number }>();
    let calls = 0;
    const f = fixture(
      async () => {
        calls++;
        return receipt.promise;
      },
      1000,
      { max: 1, ttl: 10 },
    );
    try {
      const first = f.notifications.notify({ text: "First", deduplicationKey: "first" });
      await advance(100);
      const duplicate = await f.notifications.notify({ text: "First", deduplicationKey: "first" });
      expect(duplicate).toMatchObject({ duplicate: true, status: "in-flight" });
      await expect(
        f.notifications.notify({ text: "Second", deduplicationKey: "second" }),
      ).rejects.toThrow("capacity reached");
      await expect(
        f.notifications.notify({ text: "Changed", deduplicationKey: "first" }),
      ).rejects.toThrow("different content");
      expect(f.notifications.delivery(duplicate.deliveryId)?.status).toBe("in-flight");
      expect(calls).toBe(1);
      receipt.resolve({ message_id: 9 });
      expect(await first).toMatchObject({ deliveryId: duplicate.deliveryId, status: "confirmed" });
      await expect(
        f.notifications.notify({ text: "Second", deduplicationKey: "second" }),
      ).resolves.toMatchObject({ status: "confirmed" });
      expect(calls).toBe(2);
    } finally {
      receipt.resolve({ message_id: 9 });
      await f.close();
    }
  });

  test("a fresh instance has no receipts and does not replay previous attempts", async () => {
    let calls = 0;
    const send: NotificationSender = async () => ({ message_id: ++calls });
    const first = fixture(send);
    const receipt = await first.notifications.notify({ text: "Ready", deduplicationKey: "one" });
    await first.close();
    const fresh = fixture(send);
    try {
      expect(calls).toBe(1);
      expect(fresh.notifications.delivery(receipt.deliveryId)).toBeUndefined();
      const repeated = await fresh.notifications.notify({ text: "Ready", deduplicationKey: "one" });
      expect(repeated.duplicate).toBe(false);
      expect(repeated.deliveryId).not.toBe(receipt.deliveryId);
      expect(calls).toBe(2);
    } finally {
      await fresh.close();
    }
  });

  test("uncertain outcomes expire without triggering an automatic resend", async () => {
    const advance = fakeClock();
    let calls = 0;
    const f = fixture(
      async () => {
        calls++;
        throw new Error("Unavailable");
      },
      1000,
      { max: 2, ttl: 10 },
    );
    try {
      const receipt = await f.notifications.notify({ text: "Ready", deduplicationKey: "one" });
      expect(receipt.status).toBe("uncertain");
      await advance(11);
      expect(f.notifications.delivery(receipt.deliveryId)).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("tool diagnostics correlate the execution without leaking text or provider errors", async () => {
    const logs: unknown[] = [];
    const f = fixture(async () => {
      throw new Error("private-token");
    });
    try {
      const result = await f.tool.execute(
        { text: "private message" },
        {
          ...ctx,
          execution: { id: "execution-one", session: { source: "cron", key: "example" } },
          logger: {
            ...silentLogger(),
            log(message, fields) {
              logs.push({ message, fields });
            },
          },
        },
      );
      expect(JSON.stringify(logs)).toContain("execution-one");
      expect(JSON.stringify(logs)).toContain("uncertain");
      expect(JSON.stringify({ result, logs })).not.toContain("private message");
      expect(JSON.stringify({ result, logs })).not.toContain("private-token");
    } finally {
      await f.close();
    }
  });
});
