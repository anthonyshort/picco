import * as z from "zod";
import type { Logger, SessionIdentity } from "@picco-agent/core";
import type { IdentityStore, StoredConnection } from "../store/identity-store.js";
import type { CredentialCipher } from "./cipher.js";

const EXPIRY_MARGIN_MS = 60_000;

const CredentialSchema = z
  .object({
    accessToken: z.string().min(1),
    expiresAt: z.number().optional(),
    refresh: z.object({ kind: z.literal("oauth"), state: z.json() }).optional(),
  })
  .strict();

/**
 * A normalized credential stored for every connection kind.
 */
export type Credential = z.infer<typeof CredentialSchema>;

/**
 * Credential custody and lifecycle dependencies.
 */
export interface CredentialsOptions {
  store: IdentityStore;
  cipher: CredentialCipher;
  refresh(credential: Credential): Promise<Credential | null>;
  logger(): Logger | undefined;
}

/**
 * Connection metadata as reported to users, with unusable credentials marked stale.
 */
export interface ConnectionStatus extends StoredConnection {
  stale?: true;
}

/**
 * Encrypted credential custody: save, remove, list, staleness, and single-flight refresh.
 */
export class Credentials {
  private readonly stale = new Set<string>();
  private readonly refreshes = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: CredentialsOptions) {}

  /**
   * Save a credential and heal any stale state for its slot.
   */
  async save(user: SessionIdentity, connector: string, credential: Credential): Promise<void> {
    const slot = credentialSlot(user, connector);
    const blob = await this.opts.cipher.seal(credential, slot);
    await this.opts.store.set(userKey(user), connector, {
      v: 1,
      blob,
      connectedAt: Date.now(),
      expiresAt: credential.expiresAt,
    });
    this.stale.delete(slot);
  }

  /**
   * Remove a credential and its stale state.
   */
  async remove(user: SessionIdentity, connector: string): Promise<boolean> {
    const removed = await this.opts.store.remove(userKey(user), connector);
    this.stale.delete(credentialSlot(user, connector));
    return removed;
  }

  /**
   * List non-secret connection metadata with unusable credentials marked stale.
   */
  async list(user: SessionIdentity): Promise<ConnectionStatus[]> {
    const stored = await this.opts.store.list(userKey(user));
    const connections: ConnectionStatus[] = [];
    for (const connection of stored) {
      const slot = credentialSlot(user, connection.connector);
      const credential = await this.load(user, connection.connector);
      const unusable =
        credential === null || (needsRefresh(credential.expiresAt) && !credential.refresh);
      connections.push({
        ...connection,
        stale: this.stale.has(slot) || unusable || undefined,
      });
    }
    return connections;
  }

  /**
   * Resolve a current access token, refreshing once per slot when needed.
   */
  async resolve(user: SessionIdentity, connector: string): Promise<string | null> {
    const slot = credentialSlot(user, connector);
    const credential = await this.load(user, connector);
    if (!credential) return null;
    if (!needsRefresh(credential.expiresAt)) {
      this.stale.delete(slot);
      return credential.accessToken;
    }
    if (this.stale.has(slot)) return null;
    if (!credential.refresh) {
      this.stale.add(slot);
      return null;
    }

    const activeRefresh = this.refreshes.get(slot);
    if (activeRefresh) return activeRefresh;
    const refreshPromise = this.refresh(user, connector, credential).finally(() => {
      this.refreshes.delete(slot);
    });
    this.refreshes.set(slot, refreshPromise);
    return refreshPromise;
  }

  private async load(user: SessionIdentity, connector: string): Promise<Credential | null> {
    const slot = credentialSlot(user, connector);
    const envelope = await this.opts.store.get(userKey(user), connector);
    if (!envelope) return null;
    try {
      const opened = await this.opts.cipher.open(envelope.blob, slot);
      const credential = CredentialSchema.safeParse(opened);
      if (credential.success) return credential.data;
    } catch {
      // Invalid and undecryptable credentials have the same reconnect path.
    }
    this.stale.add(slot);
    return null;
  }

  private async refresh(
    user: SessionIdentity,
    connector: string,
    fallback: Credential,
  ): Promise<string | null> {
    const current = (await this.load(user, connector)) ?? fallback;
    if (!needsRefresh(current.expiresAt)) return current.accessToken;
    const refreshed = await this.opts.refresh(current);
    if (!refreshed) {
      this.stale.add(credentialSlot(user, connector));
      this.opts.logger()?.error("refresh rejected — connection needs reconnecting", {
        user: userKey(user),
        connector,
      });
      return null;
    }
    await this.save(user, connector, refreshed);
    return refreshed.accessToken;
  }
}

/**
 * Build the canonical persistence key for a session identity.
 */
export function userKey(user: SessionIdentity): string {
  return `${user.source}:${user.id}`;
}

/**
 * Build the cipher binding for one user's connector credential.
 */
function credentialSlot(user: SessionIdentity, connector: string): string {
  return `${userKey(user)}/${connector}`;
}

/**
 * Decide whether a credential is expired or close enough to refresh safely.
 */
function needsRefresh(expiresAt: number | undefined): boolean {
  return expiresAt !== undefined && expiresAt - Date.now() < EXPIRY_MARGIN_MS;
}
