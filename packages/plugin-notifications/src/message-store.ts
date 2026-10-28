import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageRecordSchema, type MessageRecord, type MessageStore } from "./messages.js";

/**
 * Persist recipient-bound handles and compare reservations before any external write.
 */
export function createPersistentMessageStore(file: string, max: number): MessageStore {
  const database = openMessageDatabase(file);
  return {
    get: (key) => readMessageRecord(database, key),
    set: (key, record, expectedDeliveryId) =>
      writeMessageRecord(database, key, record, expectedDeliveryId, max),
    close: () => database.close(),
  };
}

/**
 * Open durable storage and release the connection if initialisation fails.
 */
function openMessageDatabase(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    database.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported notification message database version");
    database.exec(
      "CREATE TABLE IF NOT EXISTS notification_messages (key TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=1",
    );
    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}

/**
 * Decode persisted records without replaying an unfinished attempt.
 */
function readMessageRecord(database: DatabaseSync, key: string): MessageRecord | undefined {
  const row = database.prepare("SELECT data FROM notification_messages WHERE key=?").get(key);
  if (!row) return undefined;
  if (typeof row.data !== "string") throw new Error("Invalid notification message record");
  const record = MessageRecordSchema.parse(JSON.parse(row.data));
  // A previous process may have died after the external write and before confirmation.
  return record.status === "in-flight" ? { ...record, status: "uncertain" } : record;
}

/**
 * Commit capacity checks and reservation changes in one transaction.
 */
function writeMessageRecord(
  database: DatabaseSync,
  key: string,
  record: MessageRecord,
  expectedDeliveryId: string | null,
  max: number,
): void {
  const data = JSON.stringify(MessageRecordSchema.parse(record));
  database.exec("BEGIN IMMEDIATE");
  try {
    if (expectedDeliveryId === null) {
      insertMessageRecord(database, key, data, max);
    } else {
      replaceMessageRecord(database, key, data, expectedDeliveryId);
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Refuse new handles at capacity without evicting existing message identities.
 */
function insertMessageRecord(database: DatabaseSync, key: string, data: string, max: number): void {
  const count = database
    .prepare("SELECT COUNT(*) AS count FROM notification_messages")
    .get()?.count;
  if (typeof count !== "number" || count >= max)
    throw new Error("Notification message capacity reached");
  database.prepare("INSERT INTO notification_messages(key,data) VALUES (?,?)").run(key, data);
}

/**
 * Replace only the reservation observed by this writer.
 */
function replaceMessageRecord(
  database: DatabaseSync,
  key: string,
  data: string,
  expectedDeliveryId: string,
): void {
  const result = database
    .prepare(
      "UPDATE notification_messages SET data=? WHERE key=? AND json_extract(data,'$.deliveryId')=?",
    )
    .run(data, key, expectedDeliveryId);
  if (result.changes !== 1) throw new Error("Notification reservation changed");
}
