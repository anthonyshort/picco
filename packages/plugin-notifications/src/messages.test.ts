import { describe, expect, test, vi } from "vitest";
import { createMessages } from "./messages.js";
import type { AdapterResult, NotificationAdapter } from "./types.js";

/**
 * Record actual adapter operations while preserving editable provider IDs.
 */
function channel(targetId = "recipient") {
  const calls: string[] = [];
  const adapter: NotificationAdapter = {
    targetId,
    async send(text) {
      calls.push(`send:${text}`);
      return { status: "confirmed", externalId: "77" };
    },
    async update(id, text) {
      calls.push(`update:${id}:${text}`);
      return { status: "confirmed", externalId: id };
    },
  };
  return { calls, adapter };
}

/**
 * One parent-owned logical progress message.
 */
const input = { scope: "review:42", messageKey: "progress", text: "Researching" };

describe("notification messages", () => {
  test("broadcasts once, updates changed text, and leaves unchanged text alone", async () => {
    const first = channel();
    const second = channel();
    const messages = createMessages(() => ({ first: first.adapter, second: second.adapter }), {
      max: 10,
      timeoutMs: 1000,
    });
    try {
      const initial = await messages.notify(input);
      expect(initial.deliveries.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
      expect((await messages.notify(input)).deliveries.every((r) => r.duplicate)).toBe(true);
      await messages.notify({ ...input, text: "Verifying" });
      expect(first.calls).toEqual(["send:Researching", "update:77:Verifying"]);
      expect(second.calls).toEqual(first.calls);
      expect(messages.delivery(initial.deliveries[0].deliveryId)?.externalId).toBe("77");
      await messages.notify({ ...input, scope: "review:43" });
      expect(first.calls.at(-1)).toBe("send:Researching");
    } finally {
      await messages.stop();
    }
  });

  test("one uncertain channel does not block another or automatically send again", async () => {
    const good = channel();
    let attempts = 0;
    const messages = createMessages(
      () => ({
        good: good.adapter,
        bad: {
          targetId: "bad",
          async send() {
            attempts++;
            throw new Error("private transport failure");
          },
        },
      }),
      { max: 10, timeoutMs: 1000 },
    );
    try {
      expect((await messages.notify(input)).deliveries.map((r) => r.status)).toEqual([
        "confirmed",
        "uncertain",
      ]);
      const next = await messages.notify({ ...input, text: "Verifying" });
      expect(next.deliveries.map((r) => r.status)).toEqual(["confirmed", "uncertain"]);
      expect(attempts).toBe(1);
      expect(good.calls).toEqual(["send:Researching", "update:77:Verifying"]);
      expect(JSON.stringify(next)).not.toContain("private");
    } finally {
      await messages.stop();
    }
  });

  test("serialises concurrent updates so an older request cannot overwrite a newer one", async () => {
    const gate = Promise.withResolvers<AdapterResult>();
    const first = channel();
    first.adapter.send = async (text) => {
      first.calls.push(`send:${text}`);
      return gate.promise;
    };
    const messages = createMessages(() => ({ first: first.adapter }), { max: 10, timeoutMs: 1000 });
    const starting = messages.notify(input);
    const updating = messages.notify({ ...input, text: "Verifying" });
    try {
      await Promise.resolve();
      expect(first.calls).toEqual(["send:Researching"]);
      gate.resolve({ status: "confirmed", externalId: "77" });
      await Promise.all([starting, updating]);
      expect(first.calls).toEqual(["send:Researching", "update:77:Verifying"]);
    } finally {
      gate.resolve({ status: "rejected" });
      await messages.stop();
    }
  });

  test("drains queued edits on shutdown while unrelated keys run independently", async () => {
    const gate = Promise.withResolvers<AdapterResult>();
    const first = channel();
    first.adapter.send = async (text) => {
      first.calls.push(`send:${text}`);
      return text === "Researching" ? gate.promise : { status: "confirmed", externalId: "88" };
    };
    const messages = createMessages(() => ({ first: first.adapter }), { max: 3, timeoutMs: 1000 });
    const starting = messages.notify(input);
    const updating = messages.notify({ ...input, text: "Verifying" });
    const unrelated = messages.notify({ ...input, messageKey: "other", text: "Unrelated" });
    try {
      await expect(messages.notify({ ...input, messageKey: "overflow" })).rejects.toThrow(
        "capacity",
      );
      expect((await unrelated).deliveries[0].status).toBe("confirmed");
      expect(first.calls).toEqual(["send:Researching", "send:Unrelated"]);
      let stopped = false;
      const stopping = messages.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(messages.notify(input)).rejects.toThrow("stopped");
      gate.resolve({ status: "confirmed", externalId: "77" });
      await Promise.all([starting, updating, stopping]);
      expect(stopped).toBe(true);
      expect(first.calls).toEqual(["send:Researching", "send:Unrelated", "update:77:Verifying"]);
    } finally {
      gate.resolve({ status: "rejected" });
      await messages.stop();
    }
  });

  test("rejects recipient changes, unbound keys and unsupported edits without new sends", async () => {
    const first = channel();
    let adapter = first.adapter;
    const messages = createMessages(() => ({ first: adapter }), { max: 10, timeoutMs: 1000 });
    try {
      await messages.notify(input);
      adapter = channel("another-recipient").adapter;
      expect((await messages.notify({ ...input, text: "Verifying" })).deliveries[0].status).toBe(
        "rejected",
      );
      adapter = { targetId: "recipient", send: first.adapter.send };
      expect((await messages.notify({ ...input, text: "Verifying" })).deliveries[0].status).toBe(
        "rejected",
      );
      adapter = { send: first.adapter.send };
      expect((await messages.notify({ ...input, scope: "unbound" })).deliveries[0].status).toBe(
        "rejected",
      );
      expect(first.calls).toEqual(["send:Researching"]);
    } finally {
      await messages.stop();
    }
  });

  test("times out an adapter and quarantines its message even when it finishes late", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<AdapterResult>();
    const first = channel();
    first.adapter.send = async () => gate.promise;
    const messages = createMessages(() => ({ first: first.adapter }), { max: 10, timeoutMs: 100 });
    try {
      const starting = messages.notify(input);
      await vi.advanceTimersByTimeAsync(100);
      expect((await starting).deliveries[0].status).toBe("uncertain");
      gate.resolve({ status: "confirmed", externalId: "77" });
      await Promise.resolve();
      expect((await messages.notify({ ...input, text: "Verifying" })).deliveries[0].status).toBe(
        "uncertain",
      );
      expect(first.calls).toEqual([]);
    } finally {
      gate.resolve({ status: "rejected" });
      await messages.stop();
      vi.useRealTimers();
    }
  });

  test("unkeyed broadcasts send each time and shutdown rejects new work", async () => {
    const first = channel();
    const messages = createMessages(() => ({ first: first.adapter }), { max: 10, timeoutMs: 1000 });
    await messages.notify({ scope: "host", text: "Alert" });
    await messages.notify({ scope: "host", text: "Alert" });
    expect(first.calls).toEqual(["send:Alert", "send:Alert"]);
    await messages.stop();
    await expect(messages.notify(input)).rejects.toThrow("stopped");
  });
});
