import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod";

/**
 * Delivery metadata excludes message text and credentials.
 */
const DeliverySchema = z.object({
  deliveryId: z.uuid(),
  recipient: z.number().int(),
  executionId: z.string().nullable(),
  deduplicationKey: z.string().nullable(),
  digest: z.string(),
  status: z.enum(["in-flight", "confirmed", "rejected", "uncertain"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageId: z.number().int().nullable(),
});

/**
 * One durable notification intent and the strongest known delivery evidence.
 */
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * Bounds for terminal delivery metadata; unresolved intents are retained.
 */
export interface DeliveryStoreOptions {
  maxRecords: number;
  retentionMs: number;
}

/**
 * Reserve notification intents transactionally before contacting Telegram.
 */
export class DeliveryStore {
  private readonly database: DatabaseSync;

  constructor(
    file: string,
    private readonly options: DeliveryStoreOptions,
    private readonly now = Date.now,
  ) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS deliveries (
        deliveryId TEXT PRIMARY KEY,
        recipient INTEGER NOT NULL,
        executionId TEXT,
        deduplicationKey TEXT,
        digest TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        messageId INTEGER,
        UNIQUE (recipient, deduplicationKey)
      );
    `);
    this.database
      .prepare(
        "UPDATE deliveries SET status = 'uncertain', updatedAt = ? WHERE status = 'in-flight'",
      )
      .run(this.now());
  }

  /**
   * An existing key is never sent again, including after an interrupted attempt.
   */
  reserve(recipient: number, digest: string, deduplicationKey?: string, executionId?: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (deduplicationKey !== undefined) {
        const previous = this.database
          .prepare("SELECT * FROM deliveries WHERE recipient = ? AND deduplicationKey = ?")
          .get(recipient, deduplicationKey);
        if (previous) {
          const delivery = DeliverySchema.parse(previous);
          if (delivery.digest !== digest)
            throw new Error("Telegram notification key was already used for different content");
          this.database.exec("COMMIT");
          return { delivery, duplicate: true };
        }
      }
      const timestamp = this.now();
      this.database
        .prepare(
          "DELETE FROM deliveries WHERE status IN ('confirmed', 'rejected') AND updatedAt < ?",
        )
        .run(timestamp - this.options.retentionMs);
      const count = this.database.prepare("SELECT count(*) AS count FROM deliveries").get();
      if (z.object({ count: z.number() }).parse(count).count >= this.options.maxRecords)
        throw new Error("Telegram delivery history is full; inspect retained delivery records");
      const delivery: Delivery = {
        deliveryId: randomUUID(),
        recipient,
        executionId: executionId ?? null,
        deduplicationKey: deduplicationKey ?? null,
        digest,
        status: "in-flight",
        createdAt: timestamp,
        updatedAt: timestamp,
        messageId: null,
      };
      this.database
        .prepare("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(...Object.values(delivery));
      this.database.exec("COMMIT");
      return { delivery, duplicate: false };
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Persist confirmed receipts or conservative failure outcomes before reporting them.
   */
  finish(deliveryId: string, status: Delivery["status"], messageId?: number): Delivery {
    this.database
      .prepare(
        "UPDATE deliveries SET status = ?, updatedAt = ?, messageId = ? WHERE deliveryId = ?",
      )
      .run(status, this.now(), messageId ?? null, deliveryId);
    const delivery = this.get(deliveryId);
    if (!delivery) throw new Error("Telegram delivery record disappeared");
    return delivery;
  }

  /**
   * Read retained evidence without issuing a Telegram request.
   */
  get(deliveryId: string): Delivery | undefined {
    const row = this.database
      .prepare("SELECT * FROM deliveries WHERE deliveryId = ?")
      .get(deliveryId);
    return row ? DeliverySchema.parse(row) : undefined;
  }

  /**
   * Close after all owned send attempts have settled.
   */
  close(): void {
    this.database.close();
  }
}
