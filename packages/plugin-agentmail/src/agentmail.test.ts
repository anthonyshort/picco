import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContextOptions } from "@picco-agent/core/testing";
import type {
  AgentMailPort,
  EmailEventSource,
  EmailMessage,
  InboundEmail,
  MessageSummary,
} from "./client.js";
import {
  agentmail,
  buildEmailPrompt,
  mailList,
  mailReply,
  mailSearch,
  mailSend,
  mailUpdate,
  ensureMessageId,
} from "./index.js";

interface Recorder {
  sent: unknown[];
  replied: unknown[];
  updated: unknown[];
}

function fakePort(overrides: Partial<AgentMailPort> = {}): AgentMailPort & Recorder {
  const rec: Recorder = { sent: [], replied: [], updated: [] };
  const base: AgentMailPort = {
    async send(input) {
      rec.sent.push(input);
      return { messageId: "m-sent", threadId: "t1" };
    },
    async reply(messageId, input) {
      rec.replied.push({ messageId, input });
      return { messageId: "m-reply", threadId: "t1" };
    },
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async get(messageId) {
      return {
        messageId,
        threadId: "t1",
        from: "sender@example.com",
        to: [],
        timestamp: "2026-01-01",
        labels: [],
      } satisfies EmailMessage;
    },
    async update(messageId, change) {
      rec.updated.push({ messageId, change });
    },
  };
  return Object.assign(base, overrides, rec);
}

const summary = (over: Partial<MessageSummary> = {}): MessageSummary => ({
  messageId: "m1",
  threadId: "t1",
  from: "Alice <alice@example.com>",
  to: ["bot@agentmail.to"],
  subject: "Hello",
  preview: "hi there",
  timestamp: "2026-07-01",
  labels: ["unread"],
  ...over,
});

const email = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  messageId: "m1",
  threadId: "t1",
  from: "you@gmail.com",
  subject: "Please add this meeting",
  text: "The standup is at 9am tomorrow.",
  timestamp: "2026-07-01T12:00:00Z",
  ...over,
});

/**
 * A fake event source that lets the test push emails through the handler.
 */
function fakeSource() {
  let handler: ((e: InboundEmail) => Promise<void>) | undefined;
  return {
    started: false,
    stopped: false,
    async start(h: (e: InboundEmail) => Promise<void>) {
      handler = h;
      this.started = true;
    },
    stop() {
      this.stopped = true;
    },
    emit(e: InboundEmail) {
      if (!handler) throw new Error("not started");
      return handler(e);
    },
  } satisfies EmailEventSource & {
    started: boolean;
    stopped: boolean;
    emit(e: InboundEmail): Promise<void>;
  };
}

async function setup(
  opts: {
    allowlist?: string[];
    ctx?: FakePluginContextOptions;
  } = {},
) {
  const source = fakeSource();
  const onMarkProcessed = vi.fn().mockResolvedValue(undefined);
  const ctx = createFakePluginContext({ source: "agentmail", ...opts.ctx });
  const plugin = agentmail({
    apiKey: "k",
    inboxId: "i",
    source,
    allowlist: opts.allowlist ?? ["you@gmail.com"],
    onMarkProcessed,
  });
  await plugin.start!(ctx);
  return { source, onMarkProcessed, ctx, plugin };
}

describe("buildEmailPrompt", () => {
  test("includes the body and ids", () => {
    const prompt = buildEmailPrompt(email());
    expect(prompt).toContain("The standup is at 9am tomorrow.");
    expect(prompt).toContain("Message ID: m1");
    expect(prompt).toContain("you@gmail.com");
  });
});

describe("mailSend", () => {
  test("sends when every recipient is allowed", async () => {
    const port = fakePort();
    const out = await mailSend(port, ["@example.com"], {
      to: "a@example.com",
      subject: "s",
      text: "t",
    });
    expect(out).toContain("Sent");
    expect(port.sent).toHaveLength(1);
  });

  test("blocks and does not send when a recipient is off the allowlist", async () => {
    const port = fakePort();
    const out = await mailSend(port, ["you@gmail.com"], {
      to: "stranger@evil.com",
      subject: "s",
      text: "t",
    });
    expect(out).toContain("Blocked");
    expect(out).toContain("stranger@evil.com");
    expect(port.sent).toHaveLength(0);
  });

  test("blocks when a cc recipient is off the allowlist", async () => {
    const port = fakePort();
    const out = await mailSend(port, ["you@gmail.com"], {
      to: "you@gmail.com",
      cc: "stranger@evil.com",
      subject: "s",
      text: "t",
    });
    expect(out).toContain("Blocked");
    expect(port.sent).toHaveLength(0);
  });
});

describe("ensureMessageId", () => {
  test("wraps a bare RFC-822 id in angle brackets", () => {
    expect(ensureMessageId("abc@mail.gmail.com")).toBe("<abc@mail.gmail.com>");
    expect(ensureMessageId("  abc@x.com ")).toBe("<abc@x.com>");
  });

  test("leaves an already-bracketed id unchanged", () => {
    expect(ensureMessageId("<abc@mail.gmail.com>")).toBe("<abc@mail.gmail.com>");
  });

  test("mailReply resolves and replies with the bracketed id when the model strips it", async () => {
    const port = fakePort({
      async get(messageId) {
        return {
          messageId,
          threadId: "t1",
          from: "you@gmail.com",
          to: ["bot@agentmail.to"],
          timestamp: "",
          labels: [],
        };
      },
    });
    const out = await mailReply(port, ["you@gmail.com"], {
      messageId: "abc@mail.gmail.com",
      text: "hi",
    });
    expect(out).toContain("Replied");
    expect(port.replied).toEqual([{ messageId: "<abc@mail.gmail.com>", input: { text: "hi" } }]);
  });

  test("mailUpdate updates the bracketed id", async () => {
    const port = fakePort();
    await mailUpdate(port, { messageId: "abc@x.com", removeLabels: ["unread"] });
    expect(port.updated).toEqual([
      { messageId: "<abc@x.com>", change: { addLabels: undefined, removeLabels: ["unread"] } },
    ]);
  });
});

describe("mailReply", () => {
  test("replies when the original sender is allowlisted", async () => {
    const port = fakePort({
      async get(messageId) {
        return {
          messageId,
          threadId: "t1",
          from: "you@gmail.com",
          to: ["bot@agentmail.to"],
          timestamp: "",
          labels: [],
        };
      },
    });
    const out = await mailReply(port, ["you@gmail.com"], { messageId: "m1", text: "hi" });
    expect(out).toContain("Replied");
    expect(port.replied).toHaveLength(1);
  });

  test("blocks a reply to a non-allowlisted original sender", async () => {
    const port = fakePort({
      async get(messageId) {
        return {
          messageId,
          threadId: "t1",
          from: "stranger@evil.com",
          to: ["bot@agentmail.to"],
          timestamp: "",
          labels: [],
        };
      },
    });
    const out = await mailReply(port, ["you@gmail.com"], { messageId: "m1", text: "hi" });
    expect(out).toContain("Blocked");
    expect(port.replied).toHaveLength(0);
  });

  test("checks other thread recipients when replyAll is set", async () => {
    const port = fakePort({
      async get(messageId) {
        return {
          messageId,
          threadId: "t1",
          from: "you@gmail.com",
          to: ["bot@agentmail.to", "stranger@evil.com"],
          timestamp: "",
          labels: [],
        };
      },
    });
    const out = await mailReply(port, ["you@gmail.com", "bot@agentmail.to"], {
      messageId: "m1",
      text: "hi",
      replyAll: true,
    });
    expect(out).toContain("Blocked");
    expect(port.replied).toHaveLength(0);
  });
});

describe("mailList / mailSearch", () => {
  test("renders a markdown table with the message id", async () => {
    const port = fakePort({
      async list() {
        return [summary()];
      },
    });
    const out = await mailList(port, {});
    expect(out).toContain("| From | Subject | Date | Labels | Message ID |");
    expect(out).toContain("m1");
    expect(out).toContain("Hello");
  });

  test("requests only unread messages when unreadOnly is set", async () => {
    let received: string[] | undefined;
    const port = fakePort({
      async list(input) {
        received = input?.labels;
        return [];
      },
    });
    await mailList(port, { unreadOnly: true });
    expect(received).toEqual(["unread"]);
  });

  test("returns a friendly message when empty", async () => {
    const port = fakePort();
    expect(await mailSearch(port, { query: "nothing" })).toBe("No messages.");
  });
});

describe("plugin shape", () => {
  test("tools execute against the injected port with the allowlist enforced", async () => {
    const port = fakePort();
    const plugin = agentmail({
      apiKey: "k",
      inboxId: "i",
      allowlist: ["you@gmail.com"],
      port,
    });
    const send = plugin.tools!.find((t) => t.name === "mail_send")!;
    const ctx = { logger: silentLogger(), caller: { kind: "host" as const } };

    const blocked = await send.execute({ to: "evil@x.com", subject: "s", text: "t" }, ctx);
    expect(blocked).toContain("Blocked");

    const ok = await send.execute({ to: "you@gmail.com", subject: "s", text: "t" }, ctx);
    expect(ok).toContain("Sent");
    expect(port.sent).toHaveLength(1);
  });
});

describe("inbound listener", () => {
  test("wires the source handler on start and stops it on stop", async () => {
    const { source, plugin } = await setup();
    expect(source.started).toBe(true);
    await plugin.stop!();
    expect(source.stopped).toBe(true);
  });

  test("runs a turn keyed by thread id (raw key) and marks the message processed", async () => {
    const { source, onMarkProcessed, ctx } = await setup();

    await source.emit(email());

    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0]).toMatchObject({ source: "agentmail", key: "t1" });
    expect(ctx.turns[0]!.prompt).toContain("The standup is at 9am tomorrow.");
    expect(onMarkProcessed).toHaveBeenCalledWith("m1");
  });

  test("attributes the turn to the sender, resolving a display-name address", async () => {
    const { source, ctx } = await setup();

    await source.emit(email({ from: "Anthony <You@Gmail.com>" }));

    expect(ctx.turns[0]!.user).toEqual({
      source: "agentmail",
      id: "you@gmail.com",
      display: "Anthony <You@Gmail.com>",
    });
  });

  test("the dedupe window evicts its oldest id once full", async () => {
    const { source, ctx } = await setup();

    await source.emit(email({ messageId: "first", threadId: "t-first" }));
    for (let i = 0; i < 1000; i++) {
      await source.emit(email({ messageId: `filler-${i}` }));
    }

    // "first" was evicted from the window, so a redelivery runs again.
    await source.emit(email({ messageId: "first", threadId: "t-first" }));
    expect(ctx.turns.filter((turn) => turn.key === "t-first")).toHaveLength(2);
  });

  test("a failed listener start retries until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const source = fakeSource();
      const failingSource: EmailEventSource = {
        async start(onEmail) {
          attempts++;
          if (attempts === 1) throw new Error("network down");
          await source.start(onEmail);
        },
        stop: () => source.stop(),
      };
      const ctx = createFakePluginContext({ source: "agentmail" });
      const plugin = agentmail({
        apiKey: "k",
        inboxId: "i",
        source: failingSource,
        allowlist: ["you@gmail.com"],
      });

      await plugin.start!(ctx);
      expect(source.started).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);
      expect(source.started).toBe(true);

      await plugin.stop!();
      expect(source.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores email from a non-allowlisted sender", async () => {
    const { source, onMarkProcessed, ctx } = await setup();

    await source.emit(email({ from: "stranger@evil.com" }));

    expect(ctx.turns).toHaveLength(0);
    expect(onMarkProcessed).not.toHaveBeenCalled();
  });

  test("does not reprocess the same message id", async () => {
    const { source, ctx } = await setup();
    await source.emit(email());
    await source.emit(email());
    expect(ctx.turns).toHaveLength(1);
  });

  test("allows a retry after a failed turn and does not mark processed", async () => {
    let calls = 0;
    const { source, onMarkProcessed, ctx } = await setup({
      ctx: {
        reply: () => {
          calls++;
          if (calls === 1) throw new Error("boom");
          return "ok";
        },
      },
    });

    await source.emit(email()); // fails
    expect(onMarkProcessed).not.toHaveBeenCalled();

    await source.emit(email()); // retry succeeds
    expect(ctx.turns).toHaveLength(2);
    expect(onMarkProcessed).toHaveBeenCalledTimes(1);
  });
});
