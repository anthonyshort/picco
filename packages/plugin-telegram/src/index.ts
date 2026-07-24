import { Bot } from "grammy";
import * as z from "zod";
import { tool, type Tool } from "@picco-agent/core";
import type { Plugin, PluginContext, SessionIdentity } from "@picco-agent/core";

const TELEGRAM_MAX = 4096;
const TYPING_REFRESH_MS = 4000;

/**
 * Extra instructions appended to the Pi system prompt for Telegram sessions.
 */
export const TELEGRAM_SYSTEM_APPEND = `
## Telegram response rules
Your responses will be read in Telegram, which cannot render markdown.
- Use plain text only: no asterisks, backticks, hashes, or other markdown syntax.
- Keep responses short: aim for 3-6 sentences or a brief bullet list using hyphens.
- Drop code blocks entirely; if code is essential, describe what it does in one line.
- Drop headings; use short paragraphs instead.
- Keep all key facts, numbers, and conclusions.
- Show only the final result; skip intermediate reasoning or step-by-step tool output.
- Send your replies with the reply tool — you can call it multiple times as you
  work through a long task. If you don't call it, your final response text is
  delivered automatically instead.`;

/**
 * An incoming Telegram text message with the callbacks needed to reply. Created from a grammY
 * context inside the plugin's start() method.
 */
export interface IncomingTelegramMessage {
  chatId: number;
  threadId?: number;
  text: string;
  /**
   * The authenticated sender — absent for channel posts and anonymous group admins, whose turns run
   * unattributed.
   */
  from?: { id: number; username?: string; firstName?: string };
  reply(text: string): Promise<unknown>;
  /**
   * Message the sender privately (bot.api.sendMessage(from.id, …)) — how secret-bearing connection
   * commands deliver codes. Absent without `from`.
   */
  dm?(text: string): Promise<unknown>;
  sendTyping(): Promise<unknown>;
  /**
   * Post a status line; returns an updater/remover. Optional capability — live tool status is
   * skipped when absent.
   */
  postStatus?(text: string): Promise<{
    update(text: string): Promise<unknown>;
    remove(): Promise<unknown>;
  }>;
}

/**
 * Configuration for the Telegram gateway plugin. Requires a bot token and an allowlist of chat ids.
 */
export interface TelegramOptions {
  botToken: string;
  /**
   * Chat ids allowed to talk to the agent. Everything else is ignored.
   */
  allowlist: number[];
}

/**
 * Per-turn state behind the session-scoped `reply` tool: where this turn's replies deliver, and
 * whether the model used the tool during the turn.
 */
interface TurnReplyState {
  deliver: (text: string) => Promise<unknown>;
  /**
   * Set when the model replies via the tool during this turn.
   */
  replied: boolean;
}

/**
 * Build a composite session key from a chat ID and an optional thread ID. Regular chats (no thread)
 * use "general" as the thread part. Raw local key — the framework namespaces it under the plugin.
 */
export function telegramSessionKey(chatId: number, messageThreadId?: number): string {
  const thread = messageThreadId ?? "general";
  return `${chatId}-${thread}`;
}

/**
 * Split text into Telegram-sized pieces; empty input yields one "(empty)" part. A split never lands
 * inside a surrogate pair — a lone surrogate is invalid text Telegram rejects.
 */
export function chunk(text: string, size = TELEGRAM_MAX): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const lastCode = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && lastCode >= 0xd800 && lastCode <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.length ? parts : ["(empty)"];
}

/**
 * The sender as a kernel SessionIdentity: stable numeric id, display for logs only.
 */
export function telegramIdentity(
  from: IncomingTelegramMessage["from"],
): SessionIdentity | undefined {
  if (!from) return undefined;
  return { source: "telegram", id: String(from.id), display: from.username ?? from.firstName };
}

/**
 * The session-scoped reply tool: bound to one conversation, no target for the model to supply. It
 * can be called multiple times mid-turn for progressive replies.
 *
 * The tool binds once, at session creation, but delivery and the replied flag belong to a single
 * turn — so it closes over a queue of per-turn states that mirrors the session's FIFO turn queue.
 * The head is always the running turn: a message that arrives mid-turn enqueues its own state
 * without touching the state of the turn in flight.
 */
function buildReplyTool(queue: TurnReplyState[]): Tool {
  return tool({
    name: "reply",
    description:
      "Send a message to the person you're talking to. You may call this multiple times as you work; keep each message short and plain-text.",
    input: z.object({ text: z.string().min(1) }),
    async execute({ text }) {
      const state = queue[0];
      if (!state) throw new Error("No turn is running in this conversation");
      for (const part of chunk(text)) await state.deliver(part);
      state.replied = true;
      return "sent";
    },
  });
}

/**
 * Build the text-message handler. Collaborators are injected (rather than read from config /
 * grammY) so the routing logic is testable on its own — the plugin's start() adapts the grammY
 * context into IncomingTelegramMessage.
 */
export function createMessageHandler(
  ctx: PluginContext,
  options: Pick<TelegramOptions, "allowlist">,
): (message: IncomingTelegramMessage) => Promise<void> {
  const allowlist = new Set(options.allowlist);
  const replyQueues = new Map<string, TurnReplyState[]>();

  return async (message) => {
    const { chatId, threadId, text, reply, sendTyping, postStatus } = message;
    const threadLabel = threadId ?? "general";

    if (!allowlist.has(chatId)) {
      ctx.logger.log("ignoring message from non-allowlisted chat", { chatId });
      return;
    }

    ctx.logger.log("received message", { chatId, threadId: threadLabel });

    const key = telegramSessionKey(chatId, threadId);

    // Handle commands (those starting with "/")
    if (text.trim().startsWith("/")) {
      const response = await handleCommand(ctx, message, key);
      if (response) await reply(response);
      return;
    }

    // A single turn can run for minutes through multi-step tool use.
    // Telegram's "typing" status lasts ~5s, so refresh it until the turn ends.
    await sendTyping().catch(() => {});
    const typing = setInterval(() => sendTyping().catch(() => {}), TYPING_REFRESH_MS);

    // This turn's reply state joins the conversation's queue; it becomes
    // the head exactly when the session's FIFO runs this turn.
    let queue = replyQueues.get(key);
    if (!queue) {
      queue = [];
      replyQueues.set(key, queue);
    }
    const replyState: TurnReplyState = { deliver: reply, replied: false };
    queue.push(replyState);

    try {
      const turn = ctx.sessions.run(key, text, {
        // The sender rides every turn so the kernel can pin who is speaking
        // (per-user connections, user-aware tools).
        user: telegramIdentity(message.from),
        session: { pi: { instructions: TELEGRAM_SYSTEM_APPEND }, tools: [buildReplyTool(queue)] },
      });

      // Live tool status: one status message, updated per tool, removed
      // before the reply lands. Failures here must never break the turn.
      const statusDone = postStatus
        ? (async () => {
            let status: Awaited<ReturnType<NonNullable<typeof postStatus>>> | undefined;
            try {
              for await (const event of turn.events) {
                if (event.type !== "tool_start") continue;
                const line = `⚙️ ${event.tool}…`;
                if (!status) status = await postStatus(line);
                else await status.update(line);
              }
            } catch {
              /* status is cosmetic */
            } finally {
              await status?.remove().catch(() => {});
            }
          })()
        : Promise.resolve();

      const { text: replyText } = await turn;
      await statusDone;

      // Belt and braces: if the model replied via the tool, it has already
      // delivered its answer — posting the final text would duplicate it.
      if (replyState.replied) {
        ctx.logger.log("replied via reply tool", { chat: chatId, thread: threadLabel });
      } else {
        const chunks = chunk(replyText);
        for (const part of chunks) await reply(part);
        ctx.logger.log("replied", { chat: chatId, thread: threadLabel, chunks: chunks.length });
      }
    } catch (err) {
      ctx.logger.error("failed to reply", err);
      await reply("Something went wrong handling that. Check the server logs.");
    } finally {
      clearInterval(typing);
      const idx = queue.indexOf(replyState);
      if (idx !== -1) queue.splice(idx, 1);
    }
  };
}

/**
 * Dispatch a "/" command: gateway built-ins first, then plugin commands. Never the model.
 */
async function handleCommand(
  ctx: PluginContext,
  message: IncomingTelegramMessage,
  key: string,
): Promise<string | void> {
  // "/connect@my_bot linear" → name "connect", args "linear".
  const [rawName = "", ...rest] = message.text.trim().slice(1).split(/\s+/);
  const command = rawName.split("@")[0]!;
  const args = rest.join(" ");

  if (command === "new") {
    await ctx.sessions.reset(key);
    return "Started a fresh session.";
  }

  if (command === "context") {
    const session = ctx.sessions.get(key);
    if (!session) {
      return "No active session. Send a message or use /new to start one.";
    }
    const usage = await session.stats();
    if (usage.tokens === null) {
      return "Context usage is not available yet.";
    }
    return `Tokens: ${usage.tokens.toLocaleString()}`;
  }

  try {
    const handled = await ctx.commands.dispatch(command, {
      user: telegramIdentity(message.from),
      args,
      reply: async (text) => void (await message.reply(text)),
      dm: message.dm ? async (text) => void (await message.dm!(text)) : undefined,
    });
    if (handled) return;
  } catch (err) {
    ctx.logger.error("plugin command failed", { command, error: err });
    return `Sorry, /${command} failed. Check the server logs.`;
  }

  return "Unknown command";
}

/**
 * Create the Telegram plugin: long-polling bot and message routing.
 */
export function telegram(options: TelegramOptions): Plugin {
  const bot = new Bot(options.botToken);

  return {
    name: "telegram",

    async start(ctx: PluginContext) {
      const handle = createMessageHandler(ctx, options);

      const contributed = ctx.commands.list();
      const reserved = new Set(["new", "context"]);
      const collision = contributed.find((command) => reserved.has(command.name));
      if (collision) throw new Error(`Telegram command "/${collision.name}" is reserved`);
      bot.api
        .setMyCommands([
          { command: "new", description: "Start a new conversation" },
          { command: "context", description: "Show current context usage" },
          ...contributed.map(({ name: command, description }) => ({ command, description })),
        ])
        .catch((err) => ctx.logger.log("failed to set the Telegram command menu", err));

      bot.on("message:text", (telegramContext) =>
        handle({
          chatId: telegramContext.chat.id,
          threadId: telegramContext.message.message_thread_id,
          text: telegramContext.message.text,
          from: telegramContext.from
            ? {
                id: telegramContext.from.id,
                username: telegramContext.from.username,
                firstName: telegramContext.from.first_name,
              }
            : undefined,
          reply: (text) => telegramContext.reply(text),
          // DMs go to the sender's own chat with the bot — never the group.
          dm: telegramContext.from
            ? (text) => bot.api.sendMessage(telegramContext.from!.id, text)
            : undefined,
          sendTyping: () => telegramContext.replyWithChatAction("typing"),
          postStatus: async (text) => {
            const statusMessage = await telegramContext.reply(text);
            return {
              update: (next) =>
                bot.api
                  .editMessageText(telegramContext.chat.id, statusMessage.message_id, next)
                  .catch(() => {}),
              remove: () =>
                bot.api
                  .deleteMessage(telegramContext.chat.id, statusMessage.message_id)
                  .catch(() => {}),
            };
          },
        }),
      );

      // bot.start() resolves only when the bot stops — fire and forget.
      void bot
        .start({
          onStart: (me) => {
            ctx.logger.log(`Telegram bot listening - @${me.username}`);
          },
        })
        .catch((err) => ctx.logger.error("uncaught error", err));
    },

    async stop() {
      await bot.stop();
    },
  };
}
