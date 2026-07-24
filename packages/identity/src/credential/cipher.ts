import { CompactEncrypt, compactDecrypt } from "jose";
import type { Credential } from "./credentials.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_BYTES = 32;

/**
 * Seals credentials into slot-bound opaque blobs and opens them again.
 */
export interface CredentialCipher {
  /**
   * Seal a credential into an opaque blob bound to its slot (`identityKey/connector`).
   */
  seal(credential: Credential, slot: string): Promise<string>;

  /**
   * Decrypt a blob, throwing on a wrong key, tampering, or a slot mismatch.
   */
  open(blob: string, slot: string): Promise<unknown>;
}

/**
 * Create the slot-bound JWE cipher used by the identity plugin. Throws on an invalid key, so a
 * misconfigured deployment fails at construction rather than at first use.
 */
export function createCredentialCipher(encodedKey: string): CredentialCipher {
  const key = resolveEncryptionKey(encodedKey);
  return {
    async seal(credential, slot) {
      return await new CompactEncrypt(encoder.encode(JSON.stringify(credential)))
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", slot })
        .encrypt(key);
    },
    async open(blob, slot) {
      const { plaintext, protectedHeader } = await compactDecrypt(blob, key);
      if (protectedHeader.slot !== slot) throw new Error("credential slot mismatch");
      return JSON.parse(decoder.decode(plaintext)) as unknown;
    },
  };
}

/**
 * Validate a 32-byte encryption key encoded as hex or base64.
 */
function resolveEncryptionKey(key: string): Buffer {
  const encodedKey = (key ?? "").trim();
  if (!encodedKey) {
    throw new Error("identity encryptionKey is missing — generate one with: openssl rand -hex 32");
  }
  const bytes = /^[0-9a-fA-F]{64}$/.test(encodedKey)
    ? Buffer.from(encodedKey, "hex")
    : Buffer.from(encodedKey, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `identity encryptionKey must be ${KEY_BYTES} bytes (64 hex chars or 44 base64 chars) — openssl rand -hex 32`,
    );
  }
  return bytes;
}
