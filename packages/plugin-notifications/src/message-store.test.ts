import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { notifications } from "./index.js";
import { createPersistentMessageStore } from "./message-store.js";
import { createMessages, type MessageRecord } from "./messages.js";
import type { NotificationAdapter } from "./types.js";

/**
 * Isolate each real SQLite database and all its sidecars.
 */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "picco-notification-store-"));
  return {
    directory,
    file: path.join(directory, "messages.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * A reservation deliberately left unfinished at a crash boundary.
 */
function record(): MessageRecord {
  return {
    targetId: "chat:42",
    digest: "saved-digest",
    deliveryId: crypto.randomUUID(),
    destination: "chat",
    status: "in-flight",
    externalId: null,
  };
}

describe("persistent notification messages", () => {
  test("restarts edit the original message and do not persist text or evict handles", async () => {
    const state = fixture();
    const calls: string[] = [];
    const adapter: NotificationAdapter = {
      targetId: "chat:42",
      async send(text) {
        calls.push(`send:${text}`);
        return { status: "confirmed", externalId: "77" };
      },
      async update(id, text) {
        calls.push(`update:${id}:${text}`);
        return { status: "confirmed", externalId: id };
      },
    };
    const options = {
      destinations: { chat: adapter },
      messageStorePath: state.file,
      maxDeliveryRecords: 1,
    };
    let plugin = notifications(options);
    try {
      await plugin.start?.(createFakePluginContext());
      await plugin.notify({
        scope: "review",
        messageKey: "progress",
        text: "private initial text",
      });
      await plugin.stop?.();
      plugin = notifications(options);
      await plugin.start?.(createFakePluginContext());
      expect(
        (
          await plugin.notify({
            scope: "review",
            messageKey: "progress",
            text: "private initial text",
          })
        ).deliveries[0].duplicate,
      ).toBe(true);
      await plugin.notify({
        scope: "review",
        messageKey: "progress",
        text: "private changed text",
      });
      expect(calls).toEqual(["send:private initial text", "update:77:private changed text"]);
      expect(
        (await plugin.notify({ scope: "other", messageKey: "progress", text: "No capacity" }))
          .deliveries[0].status,
      ).toBe("rejected");
      expect(calls).toHaveLength(2);
      for (const file of readdirSync(state.directory))
        expect(
          readFileSync(path.join(state.directory, file)).includes(Buffer.from("private")),
        ).toBe(false);
    } finally {
      await plugin.stop?.();
      state.cleanup();
    }
  });

  test("crash-left reservations remain uncertain and cannot automatically send again", async () => {
    const state = fixture();
    let store = createPersistentMessageStore(state.file, 10);
    const key = JSON.stringify(["review", "progress", "chat"]);
    store.set(key, record(), null);
    store.close();
    store = createPersistentMessageStore(state.file, 10);
    let sends = 0;
    const messages = createMessages(
      () => ({
        chat: {
          targetId: "chat:42",
          async send() {
            sends++;
            return { status: "confirmed", externalId: "77" };
          },
        },
      }),
      { max: 10, timeoutMs: 1000 },
      store,
    );
    try {
      expect(
        (
          await messages.notify({
            scope: "review",
            messageKey: "progress",
            text: "Changed after restart",
          })
        ).deliveries[0],
      ).toMatchObject({ status: "uncertain", duplicate: true });
      expect(sends).toBe(0);
    } finally {
      await messages.stop();
      state.cleanup();
    }
  });

  test("independent connections cannot reserve the same stale record twice", () => {
    const state = fixture();
    const first = createPersistentMessageStore(state.file, 10);
    const second = createPersistentMessageStore(state.file, 10);
    try {
      const original = { ...record(), status: "confirmed" as const, externalId: "77" };
      first.set("key", original, null);
      const stale = second.get("key")!;
      const next = record();
      first.set("key", next, original.deliveryId);
      expect(() => second.set("key", record(), stale.deliveryId)).toThrow("reservation changed");
      expect(() => second.set("key", record(), null)).toThrow();
      expect(second.get("key")).toMatchObject({ deliveryId: next.deliveryId, status: "uncertain" });
    } finally {
      first.close();
      second.close();
      state.cleanup();
    }
  });

  test("a failed confirmation write returns uncertainty and preserves its no-replay reservation", async () => {
    const state = fixture();
    const store = createPersistentMessageStore(state.file, 10);
    let writes = 0;
    let sends = 0;
    const messages = createMessages(
      () => ({
        chat: {
          targetId: "chat:42",
          async send() {
            sends++;
            return { status: "confirmed", externalId: "77" };
          },
        },
      }),
      { max: 10, timeoutMs: 1000 },
      {
        ...store,
        set(key, value, expected) {
          if (++writes === 2) throw new Error("Disk full");
          store.set(key, value, expected);
        },
      },
    );
    try {
      const input = { scope: "review", messageKey: "progress", text: "Ready" };
      expect((await messages.notify(input)).deliveries[0].status).toBe("uncertain");
      expect((await messages.notify(input)).deliveries[0].status).toBe("uncertain");
      expect(sends).toBe(1);
    } finally {
      await messages.stop();
      state.cleanup();
    }
  });

  test("rejects an unknown schema before accepting notifications", () => {
    const state = fixture();
    const database = new DatabaseSync(state.file);
    database.exec("PRAGMA user_version=99");
    database.close();
    try {
      expect(() => createPersistentMessageStore(state.file, 10)).toThrow("Unsupported");
    } finally {
      state.cleanup();
    }
  });
});
