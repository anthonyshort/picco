import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseStoredEnvelope,
  type IdentityStore,
  type StoredConnection,
  type StoredEnvelope,
} from "./identity-store.js";

/**
 * Create a store backed by one mode-0600 JSON file per user and connector.
 */
export function fileStore(directory: string): IdentityStore {
  const userDirectory = (identityKey: string) =>
    path.join(directory, "users", encodeURIComponent(identityKey));
  const filePath = (identityKey: string, connector: string) =>
    path.join(userDirectory(identityKey), `${encodeURIComponent(connector)}.json`);

  return {
    async get(identityKey, connector) {
      return await readStoredEnvelope(filePath(identityKey, connector));
    },
    async set(identityKey, connector, envelope) {
      await mkdir(userDirectory(identityKey), { recursive: true, mode: 0o700 });
      await writeFile(filePath(identityKey, connector), JSON.stringify(envelope), { mode: 0o600 });
    },
    async remove(identityKey, connector) {
      try {
        await rm(filePath(identityKey, connector));
        return true;
      } catch (err) {
        // Only absence means "was not connected" — any other failure leaves the credential on
        // disk, so it must surface rather than report a successful-looking disconnect.
        const error = err as Error & { code?: string };
        if (error.code === "ENOENT") return false;
        throw err;
      }
    },
    async list(identityKey) {
      let entries: string[];
      try {
        entries = await readdir(userDirectory(identityKey));
      } catch {
        return [];
      }
      const connections: StoredConnection[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const envelope = await readStoredEnvelope(path.join(userDirectory(identityKey), entry));
        if (!envelope) continue;
        connections.push({
          connector: decodeURIComponent(entry.slice(0, -".json".length)),
          connectedAt: envelope.connectedAt,
          expiresAt: envelope.expiresAt,
        });
      }
      return connections.sort((a, b) => a.connector.localeCompare(b.connector));
    },
  };
}

/**
 * Read and validate one envelope, treating unreadable records as absent.
 */
async function readStoredEnvelope(filePath: string): Promise<StoredEnvelope | null> {
  try {
    return parseStoredEnvelope(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}
