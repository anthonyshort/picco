import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DeliveryStore } from "./delivery-store.js";

/**
 * Each test owns a real persistent ledger.
 */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "telegram-ledger-"));
  return {
    file: path.join(directory, "deliveries.sqlite"),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("DeliveryStore", () => {
  test("preserves receipts and refuses conflicting keyed content across restarts", () => {
    const files = fixture();
    const options = { maxRecords: 10, retentionMs: 1000 };
    let store = new DeliveryStore(files.file, options);
    try {
      const first = store.reserve(123, "digest", "digest:one");
      store.finish(first.delivery.deliveryId, "confirmed", 77);
      store.close();
      store = new DeliveryStore(files.file, options);
      expect(store.reserve(123, "digest", "digest:one")).toMatchObject({
        duplicate: true,
        delivery: { messageId: 77, status: "confirmed" },
      });
      expect(() => store.reserve(123, "different", "digest:one")).toThrow("different content");
      expect(store.reserve(456, "different", "digest:one").duplicate).toBe(false);
    } finally {
      store.close();
      files.remove();
    }
  });

  test("interrupted sends stay uncertain and are never reserved again", () => {
    const files = fixture();
    const options = { maxRecords: 10, retentionMs: 1 };
    let store = new DeliveryStore(files.file, options, () => 0);
    try {
      const first = store.reserve(123, "digest", "one");
      store.close();
      store = new DeliveryStore(files.file, options, () => 1_000_000);
      expect(store.get(first.delivery.deliveryId)?.status).toBe("uncertain");
      expect(store.reserve(123, "digest", "one")).toMatchObject({
        duplicate: true,
        delivery: { status: "uncertain" },
      });
    } finally {
      store.close();
      files.remove();
    }
  });

  test("retention expires terminal records but retains unresolved attempts and fails closed at capacity", () => {
    const files = fixture();
    let timestamp = 0;
    const store = new DeliveryStore(
      files.file,
      { maxRecords: 2, retentionMs: 100 },
      () => timestamp,
    );
    try {
      const terminal = store.reserve(123, "digest", "terminal");
      store.finish(terminal.delivery.deliveryId, "confirmed", 10);
      const uncertain = store.reserve(123, "digest", "uncertain");
      store.finish(uncertain.delivery.deliveryId, "uncertain");
      expect(() => store.reserve(123, "digest", "third")).toThrow("history is full");
      timestamp = 101;
      store.reserve(123, "digest", "new");
      expect(store.get(terminal.delivery.deliveryId)).toBeUndefined();
      expect(store.get(uncertain.delivery.deliveryId)?.status).toBe("uncertain");
    } finally {
      store.close();
      files.remove();
    }
  });
});
