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
  test("broadcast tool scopes logical messages by authenticated caller and host-bound routing", async () => {
    const scopes: string[] = [];
    const calls: string[] = [];
    const adapter = {
      targetId: "recipient",
      async send(text: string) {
        calls.push(text);
        return { status: "confirmed" as const, externalId: "77" };
      },
    };
    const plugin = notifications({
      destinations: { updates: adapter },
      resolveDestinations(scope) {
        scopes.push(scope);
        return { updates: adapter };
      },
    });
    await plugin.start?.(createFakePluginContext());
    try {
      const tool = plugin.tools![0];
      const input = tool.input.parse({
        action: "send",
        messageKey: "progress",
        text: "Researching",
      });
      const first = JSON.parse(String(await tool.execute(input, ctx)));
      await tool.execute(input, ctx);
      await tool.execute(input, {
        ...ctx,
        caller: { kind: "session", ref: { source: "cron", key: "other" } },
      });
      expect(first.deliveries).toMatchObject([{ destination: "updates", status: "confirmed" }]);
      expect(calls).toEqual(["Researching", "Researching"]);
      expect(scopes).toEqual([
        JSON.stringify(["session", "cron", "example"]),
        JSON.stringify(["session", "cron", "example"]),
        JSON.stringify(["session", "cron", "other"]),
      ]);
      expect(
        tool.input.safeParse({
          action: "send",
          text: "Researching",
          messageKey: "progress",
          scope: "another-session",
        }).success,
      ).toBe(false);
      await expect(plugin.notify({ scope: "", text: "Invalid" })).rejects.toThrow();
    } finally {
      await plugin.stop?.();
    }
  });

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
        { action: "send", text: "hello", deduplicationKey: "direct-only" },
        { action: "send", destination: "updates", text: "hello", messageKey: "broadcast-only" },
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
