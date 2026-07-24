// oxlint-disable-next-line import/no-unassigned-import
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { github } from "@picco-agent/plugin-github";

/**
 * Read a required environment variable, throwing if missing.
 */
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — add it to .env`);
  return value;
}

/**
 * Resolve a path relative to this file's directory.
 */
function resolvePath(relativePath: string): string {
  return path.resolve(import.meta.dirname, relativePath);
}

const agent = createAgent({
  name: "github-bot",
  pi: {
    model: "llama/qwen-27b-q6-turbo",
    thinking: "high",
    packages: ["npm:context-mode@1.0.169"],
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
  },
  runtime: bwrap(),
  plugins: [
    github({
      relayUrl: env("GITHUB_RELAY_URL"),
      botUsername: env("GITHUB_BOT_USERNAME"),
      appId: env("GITHUB_APP_ID"),
      privateKey: readFileSync(resolvePath(env("GITHUB_PRIVATE_KEY_PATH")), "utf8"),
    }),
  ],
});

await agent.start();
