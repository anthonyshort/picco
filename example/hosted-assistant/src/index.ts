// The minimal hosted-provider agent: Telegram in front of Claude via the
// Anthropic API. Contrast with ../personal-assistant, which runs a local
// model (declared under pi.models) and needs no auth at all.
// oxlint-disable-next-line import/no-unassigned-import
import "dotenv/config";
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { telegram } from "@picco-agent/plugin-telegram";

/**
 * Read a required environment variable, throwing if missing.
 */
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — add it to .env`);
  return value;
}

const allowlist = env("TELEGRAM_BOT_ALLOWED_CHATS").split(",").map(Number);
if (allowlist.some((chatId) => !Number.isSafeInteger(chatId))) {
  // A typo'd id would otherwise become NaN and the bot would silently ignore everyone.
  throw new Error("TELEGRAM_BOT_ALLOWED_CHATS must be comma-separated numeric chat IDs");
}

const agent = createAgent({
  name: "hosted-assistant",
  pi: {
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
  },
  // The ONLY credential that crosses the sandbox boundary: ANTHROPIC_API_KEY is
  // forwarded from the host env into each session, where pi's `anthropic` provider
  // reads it. Env exposure is a runtime concern — bwrap forwards only what you list.
  runtime: bwrap({ env: ["ANTHROPIC_API_KEY"] }),
  plugins: [
    telegram({
      botToken: env("TELEGRAM_BOT_TOKEN"),
      allowlist,
    }),
  ],
});

await agent.start();
