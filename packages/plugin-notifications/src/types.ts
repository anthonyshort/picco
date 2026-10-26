import * as z from "zod";
import type { Plugin } from "@picco-agent/core";

/**
 * A configured destination and caller-supplied key identify one notification intent.
 */
export const NotificationInputSchema = z
  .object({
    destination: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(65_536),
    deduplicationKey: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Arguments for a host notification. The tool adds an action for receipt inspection.
 */
export type NotificationInput = z.infer<typeof NotificationInputSchema>;

/**
 * Delivery states include attempts whose transport outcome remains unknown.
 */
export const DELIVERY_STATUSES = ["in-flight", "confirmed", "rejected", "uncertain"] as const;

/**
 * Safe receipt metadata excludes notification text, credentials and provider errors.
 */
export interface NotificationResult {
  deliveryId: string;
  destination: string;
  status: (typeof DELIVERY_STATUSES)[number];
  externalId: string | null;
  duplicate: boolean;
}

/**
 * An adapter confirms provider acceptance or a definite rejection. Throw when uncertain.
 */
export type AdapterResult = { status: "confirmed"; externalId?: string } | { status: "rejected" };

/**
 * One host-configured recipient. Honour cancellation and keep credentials in the adapter.
 */
export interface NotificationAdapter {
  send(text: string, signal: AbortSignal): Promise<AdapterResult>;
}

/**
 * Named destinations appear in the tool; recipients and credentials remain in host configuration.
 */
export interface NotificationOptions {
  destinations: Record<string, NotificationAdapter>;
  /**
   * Bound each attempt, including adapters that ignore cancellation (default 15 seconds).
   */
  timeoutMs?: number;
  /**
   * Separate limits for completed receipts and active attempts (default 10,000 each).
   */
  maxDeliveryRecords?: number;
  /**
   * Completed receipts expire after this many days (default 30).
   */
  deliveryRetentionDays?: number;
}

/**
 * Host calls and the agent tool share delivery reservations and receipts after startup.
 */
export interface NotificationPlugin extends Plugin {
  notify(input: NotificationInput): Promise<NotificationResult>;
  delivery(deliveryId: string): NotificationResult | undefined;
}
