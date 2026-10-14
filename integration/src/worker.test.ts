/**
 * Worker integration tests — the pi-version-bump canary.
 *
 * Spawns `pi --mode rpc` directly in a temp session cwd — config files (models.json, mcp.json)
 * written to {cwd}/.pi/, bridge extension copied to {cwd}/.pi/extensions/ — against the real
 * ToolBridge and a scripted OpenAI-completions endpoint, then drives it with the unchanged
 * RpcSession. What breaks here on a pi upgrade would break the bot.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { afterEach, describe, expect, test } from "vitest";
import {
  RpcSession,
  ToolBridge,
  tool,
  type Tool,
  type PiOptions,
  type TurnEvent,
} from "@picco-agent/core";
import { bridgeExtensionBundle } from "./bridge-bundle.js";
import {
  startFakeModel,
  lastToolText,
  type FakeModelServer,
  type ModelScript,
} from "./fake-model.js";
import { wrapChild } from "./wrap-child.js";

// The bundled bridge extension — a single self-contained file (zod/typebox
// inlined) that loads inside a session with no node_modules.
const bridgeExtensionSource = bridgeExtensionBundle();

interface Harness {
  cwd: string;
  rpc: RpcSession;
  server: FakeModelServer;
  bridge: ToolBridge;
  events: TurnEvent[];
  prompt(text: string, timeoutMs?: number): Promise<string>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/**
 * Write pi config files to the workspace. models.json is written verbatim — pi resolves `apiKey`
 * itself (env interpolation), exactly as the real runtime does.
 */
function writeSessionConfig(cwd: string, models: Record<string, unknown>): void {
  const agentDir = path.join(cwd, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));

  // Write the bridge extension.
  const extDir = path.join(cwd, ".pi", "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(path.join(extDir, "bridge.js"), readFileSync(bridgeExtensionSource, "utf-8"));
}

/**
 * Build pi --mode rpc CLI args from the resolved pi config.
 */
function buildPiArgs(pi: PiOptions): string[] {
  const args = ["--mode", "rpc"];

  if (pi.model) args.push("--model", pi.model);
  if (pi.thinking) args.push("--thinking", pi.thinking);
  if (pi.instructions) args.push("--append-system-prompt", pi.instructions);
  if (pi.systemPrompt) args.push("--system-prompt", pi.systemPrompt);
  if (pi.allowedTools?.length) args.push("--tools", pi.allowedTools.join(","));
  if (pi.excludedTools?.length) args.push("--exclude-tools", pi.excludedTools.join(","));

  // Trust project-local resources without prompting.
  args.push("--approve");

  // Write session transcripts to the session cwd.
  args.push("--session-dir", ".");

  return args;
}

async function startWorker(opts: {
  script: ModelScript;
  tools?: Tool[];
  /**
   * Env var name the fake provider's apiKey references as a "$VAR" in models.json — pi interpolates
   * it from the forwarded spawn env. A literal test key by default.
   */
  apiKeyEnv?: string;
  env?: Record<string, string>;
  packages?: string[];
}): Promise<Harness> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "worker-int-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));

  const server = await startFakeModel(opts.script);
  cleanups.push(() => server.close());

  const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const bridge = new ToolBridge({ tools });
  await bridge.start();
  cleanups.push(() => bridge.stop());
  const bridgeToken = bridge.issueToken({ source: "test", key: "k" });

  // The resolved pi config, exactly as a SpawnRequest would carry it (the tool
  // manifest rides SpawnRequest.tools / bridge.json separately, written below).
  const pi: PiOptions = {
    model: "fake/fake-1",
    instructions: "You are a test agent.",
    packages: opts.packages,
    models: {
      providers: {
        fake: {
          baseUrl: server.url,
          api: "openai-completions",
          // A "$ENV" ref pi interpolates from the forwarded spawn env, or a literal by default.
          apiKey: opts.apiKeyEnv ? `$${opts.apiKeyEnv}` : "test-key",
          models: [{ id: "fake-1" }],
        },
      },
    },
  };

  // Write config files and bridge extension.
  writeSessionConfig(cwd, pi.models as Record<string, unknown>);

  // Write bridge.json so the bridge extension can read its config.
  const agentDir = path.join(cwd, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const toolSpecs = (opts.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input) as Record<string, unknown>,
  }));
  // bridge.json carries the per-session bearer token value; the extension reads it directly.
  writeFileSync(
    path.join(agentDir, "bridge.json"),
    JSON.stringify({ url: bridge.callUrl(), token: bridgeToken, tools: toolSpecs }, null, 2),
  );

  // Build CLI args.
  const argv = buildPiArgs(pi);

  const child = spawn("pi", argv, {
    cwd,
    env: {
      ...process.env,
      // What both runtimes set: config discovery rides PI_CODING_AGENT_DIR, exactly as in
      // production. HOME is the session cwd only so the canary can't see the host's real ~/.pi.
      HOME: cwd,
      PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
      ...opts.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: TurnEvent[] = [];
  const rpc = new RpcSession("test-worker", wrapChild(child));
  cleanups.push(() => rpc.kill().catch(() => {}));

  return {
    cwd,
    rpc,
    server,
    bridge,
    events,
    prompt: (text, timeoutMs = 60_000) =>
      rpc.prompt(text, { timeoutMs, onEvent: (event) => events.push(event) }),
  };
}

describe("worker integration", () => {
  test("round trip: host tool over /call, real tool names, transcript + stats", async () => {
    const SECRET = "swordfish-42";
    const executed: unknown[] = [];
    const magicWord = tool({
      name: "magic_word",
      description: "Returns today's magic word.",
      input: z.object({ flavor: z.enum(["plain", "spicy"]) }),
      execute(input) {
        executed.push(input);
        return SECRET;
      },
    });
    const h = await startWorker({
      tools: [magicWord],
      script: (params) =>
        params.messages.some((m) => m.role === "tool")
          ? [{ text: `The magic word is ${lastToolText(params)}` }]
          : [{ toolCall: { name: "magic_word", args: { flavor: "plain" } } }],
    });

    const text = await h.prompt("What is the magic word?");

    // Host-side execution, zod-validated enum arg, secret round-trip.
    expect(executed).toEqual([{ flavor: "plain" }]);
    expect(text).toContain(SECRET);

    // The model was offered the tool with its real JSON schema.
    const offered = h.server.requests[0]!.params.tools!.map((t) => t.function.name);
    expect(offered).toContain("magic_word");

    // Real tool name in events — not "mcp".
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "tool_start", tool: "magic_word" }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "tool_end", tool: "magic_word", isError: false }),
    );

    // Transcript lands in the session cwd (--session-dir parity).
    const files = await readdir(h.cwd);
    expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);

    // get_session_stats answers (the /context path).
    expect(await h.rpc.stats()).toBeGreaterThan(0);
  });

  test("a throwing host tool surfaces as a model-visible error result", async () => {
    const bomb = tool({
      name: "bomb",
      description: "Always fails.",
      input: z.object({}),
      execute(): string {
        throw new Error("kaboom");
      },
    });
    const h = await startWorker({
      tools: [bomb],
      script: (params) =>
        params.messages.some((m) => m.role === "tool")
          ? [{ text: `tool said: ${lastToolText(params)}` }]
          : [{ toolCall: { name: "bomb", args: {} } }],
    });

    const text = await h.prompt("Trigger the bomb.");

    // The bridge's isError text reached the model verbatim…
    expect(text).toContain("kaboom");
    // …and the event stream marked the call as failed.
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "tool_end", tool: "bomb", isError: true }),
    );
  });

  test("an aborted turn leaves the worker usable for the next prompt", async () => {
    const h = await startWorker({ script: () => [{ hang: true }] });

    await expect(h.prompt("This will hang.", 2000)).rejects.toThrow("timed out");

    expect(h.rpc.isAlive()).toBe(true);
    // Let the abort's own agent_settled land before the next prompt registers
    // its waiter (the host runtime never reuses a timed-out session without
    // a reset; this test is about the worker process surviving the abort).
    await new Promise((resolve) => setTimeout(resolve, 500));
    h.server.setScript(() => [{ text: "recovered" }]);
    const text = await h.prompt("Are you still there?");
    expect(text).toBe("recovered");
  });

  test("a $ENV apiKey in models.json resolves from the forwarded spawn env", async () => {
    const h = await startWorker({
      script: () => [{ text: "authed" }],
      apiKeyEnv: "FAKE_PROVIDER_KEY",
      env: { FAKE_PROVIDER_KEY: "s3cret-from-env" },
    });

    const text = await h.prompt("hello");

    expect(text).toBe("authed");
    expect(h.server.requests[0]!.authorization).toBe("Bearer s3cret-from-env");
  });
});
