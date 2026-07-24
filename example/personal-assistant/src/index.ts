// oxlint-disable-next-line import/no-unassigned-import
import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gmail, github, googleCalendar, linear, notion } from "@picco-agent/connectors";
import { createAgent, DEFAULT_DATA_DIR } from "@picco-agent/core";
import { connections } from "@picco-agent/identity";
import { fileStore } from "@picco-agent/identity/store";
import { agentmail } from "@picco-agent/plugin-agentmail";
import { cron } from "@picco-agent/plugin-cron";
import { telegram } from "@picco-agent/plugin-telegram";
import { bwrap } from "@picco-agent/runtime-bwrap";
import {
  readEnvironmentList,
  readRequiredEnvironmentVariable,
  readTelegramChatAllowlist,
} from "./environment.js";

const agentName = "assistant";
const agentDataDirectory = path.join(DEFAULT_DATA_DIR, agentName);
const sharedMemoryDirectory = path.join(agentDataDirectory, "shared", "pi-hermes-memory");
const sharedProjectMemoryDirectory = path.join(agentDataDirectory, "shared", "projects-memory");
mkdirSync(sharedMemoryDirectory, { recursive: true });
mkdirSync(sharedProjectMemoryDirectory, { recursive: true });

const googleOAuthCredentials = {
  clientId: readRequiredEnvironmentVariable("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: readRequiredEnvironmentVariable("GOOGLE_OAUTH_CLIENT_SECRET"),
};

const connectionsPlugin = connections({
  encryptionKey: readRequiredEnvironmentVariable("CONNECTIONS_KEY"),
  store: fileStore(path.join(agentDataDirectory, "connections")),
  callbackUrl: process.env.CONNECTIONS_CALLBACK_URL,
  connectors: [
    linear(),
    notion(),
    github({
      clientId: readRequiredEnvironmentVariable("GITHUB_OAUTH_CLIENT_ID"),
      clientSecret: readRequiredEnvironmentVariable("GITHUB_OAUTH_CLIENT_SECRET"),
      scopes: ["repo", "read:org"],
    }),
    googleCalendar({
      ...googleOAuthCredentials,
      scopes: [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
    }),
    gmail({
      ...googleOAuthCredentials,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    }),
  ],
});

const agent = createAgent({
  name: agentName,
  pi: {
    model: "llama/qwen-27b-q6-turbo",
    thinking: "high",
    skills: [resolvePath("../skills")],
    prompts: [resolvePath("../prompts")],
    packages: [
      "npm:context-mode@1.0.169",
      "npm:pi-hermes-memory@0.8.2",
      "npm:@tintinweb/pi-subagents@0.14.2",
      "npm:@tintinweb/pi-tasks@0.7.1",
      "npm:@juicesharp/rpiv-advisor@2.0.0",
      "npm:@oresk/pi-searxng@0.2.2",
    ],
    models: {
      providers: {
        llama: {
          baseUrl: "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          apiKey: "local",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "qwen-27b-q6-turbo" }],
        },
      },
    },
    mcpServers: {
      deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
    },
  },
  runtime: bwrap({
    env: ["SEARXNG_URL", "GH_TOKEN"],
    mounts: [
      {
        source: sharedMemoryDirectory,
        target: "~/.pi/agent/pi-hermes-memory",
        mode: "rw",
      },
      {
        source: sharedProjectMemoryDirectory,
        target: "~/.pi/agent/projects-memory",
        mode: "rw",
      },
      { source: resolvePath("../agents"), target: "~/.pi/agent/agents", mode: "ro" },
    ],
  }),
  plugins: [
    connectionsPlugin,
    telegram({
      botToken: readRequiredEnvironmentVariable("TELEGRAM_BOT_TOKEN"),
      allowlist: readTelegramChatAllowlist(),
    }),
    cron({ jobDir: resolvePath("../cron") }),
    agentmail({
      apiKey: readRequiredEnvironmentVariable("AGENTMAIL_API_KEY"),
      inboxId: readRequiredEnvironmentVariable("AGENTMAIL_INBOX_ID"),
      allowlist: readEnvironmentList("AGENTMAIL_ALLOWLIST"),
    }),
  ],
});

await agent.start();

/**
 * Resolve a path relative to this module.
 */
function resolvePath(relativePath: string): string {
  return path.resolve(import.meta.dirname, relativePath);
}
