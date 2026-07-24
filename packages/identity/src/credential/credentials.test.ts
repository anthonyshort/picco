import { describe, expect, test } from "vitest";
import type { SessionIdentity } from "@picco-agent/core";
import { createCredentialCipher } from "./cipher.js";
import { Credentials, type Credential, userKey } from "./credentials.js";
import type { IdentityStore, StoredEnvelope } from "../store/identity-store.js";

const user: SessionIdentity = { source: "test", id: "user" };

interface MemoryStore extends IdentityStore {
  rows: Map<string, StoredEnvelope>;
}

describe("Credentials", () => {
  test("stores encrypted credentials and removes their connection metadata", async () => {
    const store = createMemoryStore();
    const credentials = createCredentials(store);

    await credentials.save(user, "acme", { accessToken: "secret" });

    expect(JSON.stringify(store.rows.get(`${userKey(user)}/acme`))).not.toContain("secret");
    expect(await credentials.resolve(user, "acme")).toBe("secret");
    expect(await credentials.list(user)).toEqual([
      expect.objectContaining({ connector: "acme", stale: undefined }),
    ]);
    expect(await credentials.remove(user, "acme")).toBe(true);
    expect(await credentials.resolve(user, "acme")).toBeNull();
  });

  test("marks malformed credentials stale without exposing or throwing their contents", async () => {
    const store = createMemoryStore();
    store.rows.set(`${userKey(user)}/acme`, {
      v: 1,
      blob: "invalid",
      connectedAt: 100,
    });
    const credentials = createCredentials(store);

    expect(await credentials.resolve(user, "acme")).toBeNull();
    expect(await credentials.list(user)).toEqual([
      { connector: "acme", connectedAt: 100, expiresAt: undefined, stale: true },
    ]);
  });

  test("shares a refresh and persists the rotated credential", async () => {
    const store = createMemoryStore();
    let releaseRefresh: ((credential: Credential) => void) | undefined;
    const refreshed = new Promise<Credential>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshes = 0;
    const credentials = createCredentials(store, async () => {
      refreshes++;
      return await refreshed;
    });
    await credentials.save(user, "acme", oauthCredential("expiring"));

    const first = credentials.resolve(user, "acme");
    const second = credentials.resolve(user, "acme");
    releaseRefresh?.({ accessToken: "rotated" });

    expect(await Promise.all([first, second])).toEqual(["rotated", "rotated"]);
    expect(refreshes).toBe(1);
    expect(await credentials.resolve(user, "acme")).toBe("rotated");
  });

  test("does not retry a rejected refresh until the connection is saved again", async () => {
    const store = createMemoryStore();
    let refreshes = 0;
    const credentials = createCredentials(store, async () => {
      refreshes++;
      return null;
    });
    await credentials.save(user, "acme", oauthCredential("expired"));

    expect(await credentials.resolve(user, "acme")).toBeNull();
    expect(await credentials.resolve(user, "acme")).toBeNull();
    expect(refreshes).toBe(1);

    await credentials.save(user, "acme", { accessToken: "reconnected" });
    expect(await credentials.resolve(user, "acme")).toBe("reconnected");
  });

  test("leaves a credential retryable when refresh fails transiently", async () => {
    const store = createMemoryStore();
    let refreshes = 0;
    const credentials = createCredentials(store, async () => {
      refreshes++;
      throw new Error("temporarily unavailable");
    });
    await credentials.save(user, "acme", oauthCredential("expired"));

    await expect(credentials.resolve(user, "acme")).rejects.toThrow("temporarily unavailable");
    await expect(credentials.resolve(user, "acme")).rejects.toThrow("temporarily unavailable");
    expect(refreshes).toBe(2);
  });

  test("marks an expired credential without refresh state stale", async () => {
    const store = createMemoryStore();
    const credentials = createCredentials(store);
    await credentials.save(user, "acme", { accessToken: "expired", expiresAt: 0 });

    expect(await credentials.resolve(user, "acme")).toBeNull();
    expect(await credentials.list(user)).toEqual([
      expect.objectContaining({ connector: "acme", stale: true }),
    ]);
  });

  test("lists an expired credential without refresh state as stale before any use", async () => {
    const store = createMemoryStore();
    const credentials = createCredentials(store);
    await credentials.save(user, "acme", { accessToken: "expired", expiresAt: 0 });
    await credentials.save(user, "refreshable", oauthCredential("expiring"));

    expect(await credentials.list(user)).toEqual([
      expect.objectContaining({ connector: "acme", stale: true }),
      expect.objectContaining({ connector: "refreshable", stale: undefined }),
    ]);
  });
});

/**
 * Create credential custody over the supplied in-memory store.
 */
function createCredentials(
  store: MemoryStore,
  refresh: (credential: Credential) => Promise<Credential | null> = async () => null,
): Credentials {
  return new Credentials({
    store,
    cipher: createCredentialCipher("a".repeat(64)),
    refresh,
    logger: () => undefined,
  });
}

/**
 * Create an already-expired OAuth credential.
 */
function oauthCredential(accessToken: string): Credential {
  return {
    accessToken,
    expiresAt: 0,
    refresh: { kind: "oauth", state: { refreshToken: "refresh" } },
  };
}

/**
 * Create the minimal store needed to exercise credential lifecycle behavior.
 */
function createMemoryStore(): MemoryStore {
  const rows = new Map<string, StoredEnvelope>();
  return {
    rows,
    get: async (identity, connector) => rows.get(`${identity}/${connector}`) ?? null,
    set: async (identity, connector, envelope) =>
      void rows.set(`${identity}/${connector}`, envelope),
    remove: async (identity, connector) => rows.delete(`${identity}/${connector}`),
    list: async (identity) =>
      [...rows.entries()]
        .filter(([key]) => key.startsWith(`${identity}/`))
        .map(([key, envelope]) => ({
          connector: key.slice(identity.length + 1),
          connectedAt: envelope.connectedAt,
          expiresAt: envelope.expiresAt,
        })),
  };
}
