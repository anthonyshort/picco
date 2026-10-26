import { describe, expect, test } from "vitest";
import * as z from "zod";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { notifications } from "./index.js";

/**
 * Use the same tool context as a background cron session.
 */
const ctx: ToolContext = {
  caller: { kind: "session", ref: { source: "cron", key: "example" } },
  logger: silentLogger(),
};

describe("notifications plugin", () => {
  test("one tool sends through configured destinations and inspects host receipts", async () => {
    const calls: string[] = [];
    const plugin = notifications({
      destinations: {
        updates: {
          send: async (text) => {
            calls.push(`updates:${text}`);
            return { status: "confirmed", externalId: "77" };
          },
        },
        alerts: {
          send: async (text) => {
            calls.push(`alerts:${text}`);
            return { status: "confirmed", externalId: "88" };
          },
        },
      },
    });
    expect(plugin.tools?.map(({ name }) => name)).toEqual(["notify"]);
    expect(() => plugin.delivery("missing")).toThrow("not started");
    await plugin.start?.(createFakePluginContext({ source: "notifications" }));
    try {
      const notify = plugin.tools![0]!;
      const host = await plugin.notify({
        destination: "updates",
        text: "Ready",
        deduplicationKey: "same",
      });
      const duplicate = JSON.parse(
        String(
          await notify.execute(
            notify.input.parse({
              action: "send",
              destination: "updates",
              text: "Ready",
              deduplicationKey: "same",
            }),
            ctx,
          ),
        ),
      );
      expect(duplicate).toMatchObject({
        deliveryId: host.deliveryId,
        status: "confirmed",
        externalId: "77",
        duplicate: true,
      });
      const other = await plugin.notify({
        destination: "alerts",
        text: "Different",
        deduplicationKey: "same",
      });
      expect(other).toMatchObject({ destination: "alerts", externalId: "88", duplicate: false });
      expect(other.deliveryId).not.toBe(host.deliveryId);
      const lookup = await notify.execute(
        notify.input.parse({ action: "status", deliveryId: host.deliveryId }),
        ctx,
      );
      expect(JSON.parse(String(lookup))).toMatchObject({
        deliveryId: host.deliveryId,
        status: "confirmed",
      });
      expect(calls).toEqual(["updates:Ready", "alerts:Different"]);
      expect(
        JSON.parse(
          String(await notify.execute({ action: "status", deliveryId: crypto.randomUUID() }, ctx)),
        ),
      ).toEqual({ found: false });
      expect(z.toJSONSchema(notify.input)).toMatchObject({
        type: "object",
        properties: { destination: { enum: ["updates", "alerts"] } },
      });
      for (const input of [
        { action: "send", destination: "unknown", text: "hello" },
        { action: "send", destination: "updates", text: "hello", chatId: 999 },
        { action: "send", destination: "updates", text: "   " },
        { action: "send", destination: "updates", text: "x".repeat(65_537) },
        { action: "send", text: "hello" },
        { action: "send", destination: "updates" },
        { action: "status" },
        { action: "status", deliveryId: host.deliveryId, text: "hello" },
        { action: "send", destination: "updates", text: "hello", deliveryId: host.deliveryId },
      ])
        expect(notify.input.safeParse(input).success).toBe(false);
      await expect(plugin.notify({ destination: "unknown", text: "hello" })).rejects.toThrow(
        "Unknown notification destination",
      );
    } finally {
      await plugin.stop?.();
    }
    expect(() => plugin.delivery("missing")).toThrow("not started");
  });

  test("requires at least one configured destination and bounded limits", () => {
    expect(() => notifications({ destinations: {} })).toThrow();
    expect(() =>
      notifications({
        destinations: { updates: { send: async () => ({ status: "confirmed" }) } },
        timeoutMs: 0,
      }),
    ).toThrow();
  });
});
