import { beforeEach, describe, expect, test } from "vitest";
import type { IdentityStore, StoredEnvelope } from "../store/identity-store.js";

/**
 * Create opaque store data; plaintext contents belong to the cipher tests.
 */
export function storedEnvelope(connectedAt: number, expiresAt?: number): StoredEnvelope {
  return { v: 1, blob: "opaque-blob", connectedAt, expiresAt };
}

/**
 * Register the IdentityStore contract suite against a backend factory. Every store backend —
 * built-in or custom — must pass it.
 */
export function describeStoreContract(name: string, createStore: () => IdentityStore) {
  describe(name, () => {
    let store: IdentityStore;
    beforeEach(() => {
      store = createStore();
    });

    test("get returns null before set, the envelope after, null after remove", async () => {
      expect(await store.get("telegram:1", "github")).toBeNull();

      const envelope = storedEnvelope(100, 200);
      await store.set("telegram:1", "github", envelope);
      expect(await store.get("telegram:1", "github")).toEqual(envelope);

      expect(await store.remove("telegram:1", "github")).toBe(true);
      expect(await store.get("telegram:1", "github")).toBeNull();
      expect(await store.remove("telegram:1", "github")).toBe(false);
    });

    test("set overwrites in place (reconnect replaces the credential)", async () => {
      await store.set("telegram:1", "github", storedEnvelope(100));
      const second = storedEnvelope(300, 400);
      await store.set("telegram:1", "github", second);

      expect(await store.get("telegram:1", "github")).toEqual(second);
      expect(await store.list("telegram:1")).toEqual([
        { connector: "github", connectedAt: 300, expiresAt: 400 },
      ]);
    });

    test("list reports lifecycle metadata per connector, scoped to the user", async () => {
      await store.set("telegram:1", "github", storedEnvelope(100));
      await store.set("telegram:1", "linear", storedEnvelope(200, 900));
      await store.set("telegram:2", "github", storedEnvelope(300));

      expect(await store.list("telegram:1")).toEqual([
        { connector: "github", connectedAt: 100, expiresAt: undefined },
        { connector: "linear", connectedAt: 200, expiresAt: 900 },
      ]);
      expect(await store.list("telegram:9")).toEqual([]);
    });

    test("users and connectors with hostile names stay isolated", async () => {
      // A user string trying to escape its directory, a connector with a slash.
      await store.set("telegram:../../etc", "pass/wd", storedEnvelope(1));

      expect(await store.get("telegram:../../etc", "pass/wd")).not.toBeNull();
      expect(await store.get("telegram:1", "passwd")).toBeNull();
      expect(await store.list("telegram:../../etc")).toEqual([
        { connector: "pass/wd", connectedAt: 1, expiresAt: undefined },
      ]);
    });
  });
}
