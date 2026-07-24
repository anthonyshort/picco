import { describe, expect, test } from "vitest";
import type { AgentMailClient } from "agentmail";
import { createWebsocketEmailSource, matchesAllowlist } from "./client.js";

describe("matchesAllowlist", () => {
  test("matches an exact address case-insensitively", () => {
    expect(matchesAllowlist("You@Gmail.com", ["you@gmail.com"])).toBe(true);
    expect(matchesAllowlist("other@gmail.com", ["you@gmail.com"])).toBe(false);
  });

  test("matches a domain suffix entry", () => {
    expect(matchesAllowlist("anyone@nominal.io", ["@nominal.io"])).toBe(true);
    expect(matchesAllowlist("anyone@evil.io", ["@nominal.io"])).toBe(false);
  });

  test("extracts the address from a display-name form", () => {
    expect(matchesAllowlist("Anthony <you@gmail.com>", ["you@gmail.com"])).toBe(true);
  });

  test("fails closed on an empty allowlist", () => {
    expect(matchesAllowlist("you@gmail.com", [])).toBe(false);
  });
});

describe("createWebsocketEmailSource", () => {
  test("resubscribes when the reconnecting socket reopens", async () => {
    const handlers: Record<string, (arg: never) => void> = {};
    const subscribes: unknown[] = [];
    const fakeSocket = {
      on: (event: string, callback: (arg: never) => void) => {
        handlers[event] = callback;
      },
      sendSubscribe: (message: unknown) => {
        subscribes.push(message);
      },
      waitForOpen: async () => {},
      close: () => {},
    };
    // The SDK client is a vendor class — faking it structurally needs the cast; this is the one
    // module below the package's injection seam, so the external boundary is mocked directly.
    const client = {
      websockets: { connect: async () => fakeSocket },
    } as unknown as AgentMailClient;

    const source = createWebsocketEmailSource(client, "inbox-1");
    await source.start(async () => {});
    expect(subscribes).toEqual([{ type: "subscribe", inboxIds: ["inbox-1"] }]);

    // The SDK reconnects after a drop but does not replay the subscription — our open handler must.
    handlers["open"]!(undefined as never);
    expect(subscribes).toHaveLength(2);

    source.stop();
  });
});
