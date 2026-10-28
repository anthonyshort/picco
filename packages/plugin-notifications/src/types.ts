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
 * Broadcast to host-bound channels; a stable key updates their existing messages.
 */
export const NotificationBroadcastSchema = z
  .object({
    scope: z.string().min(1).max(1000),
    messageKey: z.string().min(1).max(200).optional(),
    text: NotificationInputSchema.shape.text,
  })
  .strict();

/**
 * Hosts choose a scope; the model tool derives it from its authenticated caller.
 */
export type NotificationBroadcast = z.infer<typeof NotificationBroadcastSchema>;

/**
 * Each channel reports independently, including partial broadcast delivery.
 */
export interface NotificationBroadcastResult {
  scope: string;
  messageKey?: string;
  deliveries: NotificationResult[];
}

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
  /**
   * Stable recipient identity, required for keyed messages. Never include credentials.
   */
  readonly targetId?: string;
  send(text: string, signal: AbortSignal): Promise<AdapterResult>;
  update?(externalId: string, text: string, signal: AbortSignal): Promise<AdapterResult>;
}

/**
 * Named destinations appear in the tool; recipients and credentials remain in host configuration.
 */
export interface NotificationOptions {
  destinations: Record<string, NotificationAdapter>;
  /**
   * Bind channels to an authorised run or session; only the host chooses recipients.
   */
  resolveDestinations?: (scope: string) => Record<string, NotificationAdapter>;
  /**
   * Keyed message handles survive restarts. Defaults to the plugin's messages.sqlite file.
   */
  messageStorePath?: string;
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
  notify(input: NotificationBroadcast): Promise<NotificationBroadcastResult>;
  delivery(deliveryId: string): NotificationResult | undefined;
}
