/**
 * `@picco-agent/identity-sqlite` — a SQLite-backed IdentityStore for `@picco-agent/identity`.
 * Encryption stays above the store (in the identity plugin's cipher), so this backend persists only
 * opaque envelopes.
 */
import {
  parseStoredEnvelope,
  type IdentityStore,
  type StoredConnection,
} from "@picco-agent/identity/store";

/**
 * The SQLite driver operations this store uses. The interface is structural so adapters for
 * different drivers can satisfy it.
 */
export interface SqliteLike {
  run(sql: string): unknown;
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

/**
 * SQLite-backed store. One table, created on first use: connections(user, connector, envelope,
 * connected_at, expires_at, PRIMARY KEY (user, connector))
 */
export function sqliteStore(db: SqliteLike): IdentityStore {
  db.run(
    `CREATE TABLE IF NOT EXISTS connections (
       user TEXT NOT NULL,
       connector TEXT NOT NULL,
       envelope TEXT NOT NULL,
       connected_at INTEGER NOT NULL,
       expires_at INTEGER,
       PRIMARY KEY (user, connector)
     )`,
  );

  return {
    async get(identityKey, connector) {
      const row = db
        .query(`SELECT envelope FROM connections WHERE user = ? AND connector = ?`)
        .get(identityKey, connector) as { envelope: string } | null | undefined;
      if (!row) return null;
      try {
        return parseStoredEnvelope(JSON.parse(row.envelope));
      } catch {
        // A corrupt envelope column reads as "not connected", matching the schema-mismatch path —
        // the user reconnects and set() heals the row.
        return null;
      }
    },

    async set(identityKey, connector, envelope) {
      db.query(
        `INSERT INTO connections (user, connector, envelope, connected_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user, connector) DO UPDATE SET
           envelope = excluded.envelope,
           connected_at = excluded.connected_at,
           expires_at = excluded.expires_at`,
      ).run(
        identityKey,
        connector,
        JSON.stringify(envelope),
        envelope.connectedAt,
        envelope.expiresAt ?? null,
      );
    },

    async remove(identityKey, connector) {
      const { changes } = db
        .query(`DELETE FROM connections WHERE user = ? AND connector = ?`)
        .run(identityKey, connector);
      return changes > 0;
    },

    async list(identityKey) {
      const rows = db
        .query(
          `SELECT connector, connected_at, expires_at FROM connections
           WHERE user = ? ORDER BY connector`,
        )
        .all(identityKey) as {
        connector: string;
        connected_at: number;
        expires_at: number | null;
      }[];
      return rows.map(
        (r): StoredConnection => ({
          connector: r.connector,
          connectedAt: r.connected_at,
          expiresAt: r.expires_at ?? undefined,
        }),
      );
    },
  };
}
