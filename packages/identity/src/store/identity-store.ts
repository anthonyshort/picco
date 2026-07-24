import * as z from "zod";

const StoredEnvelopeSchema = z.object({
  v: z.literal(1),
  blob: z.string(),
  connectedAt: z.number(),
  expiresAt: z.number().optional(),
});

/**
 * A validated encrypted envelope accepted by storage backends. `blob` is the sealed ciphertext;
 * timestamps are epoch milliseconds.
 */
export type StoredEnvelope = z.infer<typeof StoredEnvelopeSchema>;

/**
 * Store-visible metadata for one connection.
 */
export interface StoredConnection {
  connector: string;
  connectedAt: number;
  expiresAt?: number;
}

/**
 * Persistence contract that receives encrypted envelopes only. A store is dumb keyed persistence —
 * expiry is enforced by the caller, never filtered here.
 */
export interface IdentityStore {
  /**
   * Return the stored envelope, or null when absent.
   */
  get(identityKey: string, connector: string): Promise<StoredEnvelope | null>;

  /**
   * Store an envelope, replacing any existing one for the same key pair.
   */
  set(identityKey: string, connector: string, envelope: StoredEnvelope): Promise<void>;

  /**
   * Delete a connection; returns whether one existed.
   */
  remove(identityKey: string, connector: string): Promise<boolean>;

  /**
   * List connection metadata for one identity, without blobs.
   */
  list(identityKey: string): Promise<StoredConnection[]>;
}

/**
 * Validate untrusted backend data as a stored envelope.
 */
export function parseStoredEnvelope(raw: unknown): StoredEnvelope | null {
  const result = StoredEnvelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}
