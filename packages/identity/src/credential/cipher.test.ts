import { describe, expect, test } from "vitest";
import type { Credential } from "./credentials.js";
import { createCredentialCipher } from "./cipher.js";

const cipher = createCredentialCipher("a".repeat(64));
const other = createCredentialCipher("b".repeat(64));

const credential: Credential = {
  accessToken: "at-secret",
  expiresAt: 1_700_000_000_000,
  refresh: {
    kind: "oauth",
    state: { tokenUrl: "https://example.com/token", clientId: "client", refreshToken: "rt-secret" },
  },
};

describe("createCredentialCipher", () => {
  describe("encryption", () => {
    test("seals and opens a credential without readable secrets", async () => {
      const blob = await cipher.seal(credential, "telegram:1/github");

      expect(blob).not.toContain("at-secret");
      expect(blob).not.toContain("rt-secret");
      expect(await cipher.open(blob, "telegram:1/github")).toEqual(credential);
    });

    test("rejects a wrong key, tampered blob, or moved slot", async () => {
      const blob = await cipher.seal(credential, "telegram:1/github");

      await expect(other.open(blob, "telegram:1/github")).rejects.toThrow();
      await expect(cipher.open(blob.slice(0, -4) + "AAAA", "telegram:1/github")).rejects.toThrow();
      await expect(cipher.open(blob, "telegram:2/github")).rejects.toThrow();
    });
  });

  describe("key validation", () => {
    test("accepts a 32-byte key as hex or base64", () => {
      expect(() => createCredentialCipher("c".repeat(64))).not.toThrow();
      expect(() => createCredentialCipher(Buffer.alloc(32, 7).toString("base64"))).not.toThrow();
    });

    test("wrong-length or missing keys fail at construction and include the fix", () => {
      expect(() => createCredentialCipher("deadbeef")).toThrow("openssl rand -hex 32");
      expect(() => createCredentialCipher("")).toThrow("openssl rand -hex 32");
    });
  });
});
