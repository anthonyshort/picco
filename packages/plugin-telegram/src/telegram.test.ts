import { describe, expect, test } from "vitest";
import { silentLogger } from "@picco-agent/core";
import {
  createFakePluginContext,
  type FakePluginContextOptions,
  type FakePluginContext,
} from "@picco-agent/core/testing";
import type { Command, CommandContext, ToolContext } from "@picco-agent/core";
import {
  chunk,
  createMessageHandler,
  telegramSessionKey,
  TELEGRAM_SYSTEM_APPEND,
  type IncomingTelegramMessage,
} from "./index.js";

const toolCtx = (key: string): ToolContext => ({
  logger: silentLogger(),
  caller: { kind: "session", ref: { source: "telegram", key } },
});

function setup(opts: FakePluginContextOptions = {}) {
  const ctx = createFakePluginContext({ source: "telegram", ...opts });
  const handler = createMessageHandler(ctx, { allowlist: [1] });
  const replies: string[] = [];
  const statusLines: string[] = [];
  let statusRemoved = false;

  const message = (msg: Partial<IncomingTelegramMessage> = {}): IncomingTelegramMessage => ({
    chatId: 1,
    text: "hello",
    reply: async (text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
    postStatus: async (text) => {
      statusLines.push(text);
      return {
        update: async (next: string) => {
          statusLines.push(next);
        },
        remove: async () => {
          statusRemoved = true;
        },
      };
    },
    ...msg,
  });

  return {
    ctx,
    handler,
    message,
    replies,
    statusLines,
    statusRemoved: () => statusRemoved,
  };
}

describe("telegram message handler", () => {
  test("ignores messages from chats not in the allowlist", async () => {
    const { handler, message, ctx, replies } = setup();

    await handler(message({ chatId: 999 }));
    await handler(message({ chatId: 999, text: "/new" }));

    expect(ctx.turns).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("runs a turn keyed by chat and replies with the agent's response", async () => {
    const { handler, message, ctx, replies } = setup();

    await handler(message({ text: "what's up?" }));

    expect(replies).toEqual(["echo: what's up?"]);
    expect(ctx.turns).toEqual([
      {
        source: "telegram",
        key: "1-general",
        prompt: "what's up?",
        user: undefined,
        session: {
          pi: { instructions: TELEGRAM_SYSTEM_APPEND },
          tools: [expect.objectContaining({ name: "reply" })],
        },
      },
    ]);
  });

  test("derives the session key from the thread id", async () => {
    const { handler, message, ctx } = setup();

    await handler(message({ threadId: 42 }));

    expect(ctx.turns[0]!.key).toBe("1-42");
    expect(telegramSessionKey(1)).toBe("1-general");
  });

  test("applies the Telegram system append on session creation", async () => {
    const { handler, message, ctx } = setup();

    await handler(message());

    expect(ctx.sessions.get("1-general")).toBeDefined();
    expect(ctx.turns[0]!.session?.pi?.instructions).toBe(TELEGRAM_SYSTEM_APPEND);
  });

  test("/new resets the session and confirms", async () => {
    const { handler, message, ctx, replies } = setup();
    await handler(message());
    expect(ctx.sessions.get("1-general")).toBeDefined();

    await handler(message({ text: "/new" }));

    expect(replies.at(-1)).toBe("Started a fresh session.");
    expect(ctx.sessions.get("1-general")).toBeUndefined();
  });

  test("/context reports no session, then unavailable usage, then tokens", async () => {
    const { handler, message, replies, ctx } = setup({ tokens: 12345 });

    await handler(message({ text: "/context" }));
    expect(replies.at(-1)).toBe("No active session. Send a message or use /new to start one.");

    await ctx.sessions.open("1-general");
    await handler(message({ text: "/context" }));
    expect(replies.at(-1)).toBe("Context usage is not available yet.");

    await handler(message({ text: "run a turn" }));
    await handler(message({ text: "/context" }));
    expect(replies.at(-1)).toBe(`Tokens: ${(12345).toLocaleString()}`);
  });

  test("unknown commands get the unknown-command reply", async () => {
    const { handler, message, replies } = setup();
    await handler(message({ text: "/bogus" }));
    expect(replies).toEqual(["Unknown command"]);
  });

  test("splits replies longer than the Telegram limit into chunks", async () => {
    const long = "x".repeat(4096 + 100);
    const { handler, message, replies } = setup({ reply: () => long });

    await handler(message());

    expect(replies).toHaveLength(2);
    expect(replies[0]).toHaveLength(4096);
    expect(replies[1]).toHaveLength(100);
    expect(replies.join("")).toBe(long);
  });

  test("replies with a placeholder when the agent returns an empty string", async () => {
    const { handler, message, replies } = setup({ reply: () => "" });
    await handler(message());
    expect(replies).toEqual(["(empty)"]);
  });

  test("replies with an error message when the turn fails", async () => {
    const { handler, message, replies } = setup({
      reply: () => {
        throw new Error("boom");
      },
    });

    await handler(message());

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Something went wrong");
  });

  test("renders live tool status from turn events and removes it before replying", async () => {
    const { handler, message, replies, statusLines, statusRemoved } = setup({
      reply: () => ({
        text: "done",
        events: [
          { type: "tool_start", tool: "read", toolCallId: "t1" },
          { type: "tool_end", tool: "read", toolCallId: "t1", isError: false },
          { type: "tool_start", tool: "bash", toolCallId: "t2" },
          { type: "tool_end", tool: "bash", toolCallId: "t2", isError: false },
        ],
      }),
    });

    await handler(message());

    expect(statusLines).toEqual(["⚙️ read…", "⚙️ bash…"]);
    expect(statusRemoved()).toBe(true);
    expect(replies).toEqual(["done"]);
  });

  test("works without the postStatus capability", async () => {
    const { handler, message, replies } = setup();
    await handler(message({ postStatus: undefined }));
    expect(replies).toEqual(["echo: hello"]);
  });

  test("attaches the sender as a SessionIdentity on every turn", async () => {
    const { handler, message, ctx } = setup();

    await handler(message({ from: { id: 123, username: "anthony" } }));

    expect(ctx.turns[0]!.user).toEqual({ source: "telegram", id: "123", display: "anthony" });
  });

  test("falls back to firstName for display and runs unattributed without a sender", async () => {
    const { handler, message, ctx } = setup();

    await handler(message({ from: { id: 9, firstName: "Sam" } }));
    await handler(message({ from: undefined }));

    expect(ctx.turns[0]!.user).toEqual({ source: "telegram", id: "9", display: "Sam" });
    expect(ctx.turns[1]!.user).toBeUndefined();
  });
});

describe("telegram plugin commands", () => {
  function commandSetup(handler?: (ctx: CommandContext) => Promise<void>) {
    const calls: CommandContext[] = [];
    const commands: Command[] = [
      {
        name: "connect",
        description: "Connect an account",
        handler: async (ctx) => {
          calls.push(ctx);
          await (handler ?? (async ({ dm }) => void (await dm?.("check your DMs"))))(ctx);
        },
      },
    ];
    const ctx = createFakePluginContext({ source: "telegram", commands });
    const dispatch = createMessageHandler(ctx, { allowlist: [1] });
    const replies: string[] = [];
    const dms: string[] = [];
    const message = (msg: Partial<IncomingTelegramMessage> = {}): IncomingTelegramMessage => ({
      chatId: 1,
      text: "/connect linear",
      from: { id: 123, username: "anthony" },
      reply: async (text) => void replies.push(text),
      dm: async (text) => void dms.push(text),
      sendTyping: async () => {},
      ...msg,
    });
    return { calls, ctx, dispatch, message, replies, dms };
  }

  test("dispatches a contributed command with sender, args, reply, and dm", async () => {
    const { dispatch, message, calls, dms, ctx } = commandSetup();

    await dispatch(message({ text: "/connect@my_bot linear" }));

    expect(calls[0]).toMatchObject({
      user: { source: "telegram", id: "123", display: "anthony" },
      args: "linear",
    });
    expect(dms).toEqual(["check your DMs"]);
    expect(ctx.turns).toHaveLength(0);
  });

  test("built-ins win and unknown commands reply without invoking plugins", async () => {
    const { dispatch, message, replies, calls, ctx } = commandSetup();
    await ctx.sessions.open("1-general");

    await dispatch(message({ text: "/new" }));
    await dispatch(message({ text: "/bogus" }));

    expect(calls).toHaveLength(0);
    expect(replies).toEqual(["Started a fresh session.", "Unknown command"]);
  });

  test("passes an absent sender to commands that decide whether identity is required", async () => {
    const { dispatch, message, calls } = commandSetup();

    await dispatch(message({ from: undefined, dm: undefined }));

    expect(calls[0]!.user).toBeUndefined();
  });

  test("turns a throwing command into an apology", async () => {
    const { dispatch, message, replies } = commandSetup(async () => {
      throw new Error("plugin exploded");
    });

    await dispatch(message());

    expect(replies[0]).toContain("/connect failed");
  });
});

describe("telegram session-scoped reply tool", () => {
  test("binds a reply tool to the conversation at session creation", async () => {
    const { handler, message, ctx } = setup();

    await handler(message());

    expect(ctx.sessionTools).toHaveLength(1);
    expect(ctx.sessionTools[0]!.key).toBe("1-general");
    expect(ctx.sessionTools[0]!.tools.map((t) => t.name)).toEqual(["reply"]);
  });

  test("delivers tool replies chunked and suppresses the final text when used", async () => {
    const progressive = "x".repeat(4096 + 100);
    const holder: { ctx?: FakePluginContext } = {};
    const { handler, message, ctx, replies } = setup({
      // The scripted turn plays the model: it calls the bound reply tool
      // mid-turn, exactly as pi would through the bridge.
      reply: async () => {
        const reply = holder.ctx!.sessionTools[0]!.tools[0]!;
        await reply.execute({ text: progressive }, toolCtx("1-general"));
        return "final text the gateway must not repeat";
      },
    });
    holder.ctx = ctx;

    await handler(message());

    expect(replies).toHaveLength(2);
    expect(replies[0]).toHaveLength(4096);
    expect(replies.join("")).toBe(progressive);
  });

  test("falls back to posting the final text on turns where the tool goes unused", async () => {
    let useTool = true;
    const holder: { ctx?: FakePluginContext } = {};
    const { handler, message, ctx, replies } = setup({
      reply: async () => {
        if (useTool) {
          const reply = holder.ctx!.sessionTools[0]!.tools[0]!;
          await reply.execute({ text: "progress" }, toolCtx("1-general"));
          return "suppressed";
        }
        return "posted as final text";
      },
    });
    holder.ctx = ctx;

    await handler(message());
    expect(replies).toEqual(["progress"]);

    // The replied flag is per-turn: the next turn (tool unused) falls back.
    useTool = false;
    await handler(message({ text: "again" }));
    expect(replies).toEqual(["progress", "posted as final text"]);
  });

  test("a message arriving mid-turn cannot clobber the running turn's reply state", async () => {
    // The old conversation-level ReplyState raced: B arriving during turn A
    // reset replied=false, A's tool call set it true, and B's final text was
    // then wrongly suppressed. Per-turn states make each turn independent.
    const holder: { ctx?: FakePluginContext } = {};
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const gateA = gate();
    const gateB = gate();
    const { handler, message, ctx } = setup({
      reply: async ({ prompt }) => {
        if (prompt === "slow") {
          await gateA.opened;
          const reply = holder.ctx!.sessionTools[0]!.tools[0]!;
          await reply.execute({ text: "progress from A" }, toolCtx("1-general"));
          return "A final (suppressed)";
        }
        await gateB.opened; // B completes only after A's tool call has fired
        return "B final text";
      },
    });
    holder.ctx = ctx;

    const aReplies: string[] = [];
    const bReplies: string[] = [];
    const turnA = handler(
      message({
        text: "slow",
        reply: async (t) => {
          aReplies.push(t);
        },
      }),
    );
    const turnB = handler(
      message({
        text: "quick",
        reply: async (t) => {
          bReplies.push(t);
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // The race sequence: B is already in flight, then A calls the tool…
    gateA.open();
    await turnA;
    expect(aReplies).toEqual(["progress from A"]); // A's tool delivery + suppressed final

    // …and B, which never used the tool, must still post its final text.
    gateB.open();
    await turnB;
    expect(bReplies).toEqual(["B final text"]);
  });

  test("delivers via the latest message even though the tool binds once", async () => {
    const holder: { ctx?: FakePluginContext } = {};
    const { handler, message, ctx, replies } = setup({
      reply: async () => {
        const reply = holder.ctx!.sessionTools[0]!.tools[0]!;
        await reply.execute({ text: "update" }, toolCtx("1-general"));
        return "suppressed";
      },
    });
    holder.ctx = ctx;

    await handler(message());
    expect(replies).toEqual(["update"]);

    // Second message in the same conversation: the tool (bound at session
    // creation) must route through this message's reply, not the first one's.
    const laterReplies: string[] = [];
    await handler(
      message({
        text: "again",
        reply: async (text) => {
          laterReplies.push(text);
        },
      }),
    );

    expect(replies).toEqual(["update"]);
    expect(laterReplies).toEqual(["update"]);
    expect(ctx.sessionTools).toHaveLength(1);
  });
});

describe("chunk", () => {
  test("returns a placeholder for empty input and splits at the limit", () => {
    expect(chunk("")).toEqual(["(empty)"]);
    expect(chunk("abc", 2)).toEqual(["ab", "c"]);
  });

  test("never splits a surrogate pair at the chunk boundary", () => {
    expect(chunk("a\u{1F600}b", 2)).toEqual(["a", "\u{1F600}", "b"]);
    expect(chunk("\u{1F600}\u{1F600}", 3)).toEqual(["\u{1F600}", "\u{1F600}"]);
  });
});
