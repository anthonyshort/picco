/**
 * Local() integration — the real worker driven through the real SessionManager with no bubblewrap:
 * the first end-to-end test that runs on any machine (macOS and dev boxes included — the bwrap
 * suite skips where bubblewrap is missing, this one never skips). A scripted OpenAI-completions
 * endpoint stands in for the model; everything else — manager, runtime, worker process, RPC, tool
 * bridge — is real.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { afterEach, describe, expect, test } from "vitest";
import { local } from "@picco-agent/runtime-local";
import {
  createAgentPaths,
  SessionManager,
  ToolBridge,
  tool,
  type Tool,
  type TurnEvent,
} from "@picco-agent/core";
import { bridgeExtensionBundle } from "./bridge-bundle.js";
import {
  startFakeModel,
  lastToolText,
  type ChatRequest,
  type FakeModelServer,
  type ModelAction,
} from "./fake-model.js";

// The bundled bridge extension — a single self-contained file (zod/typebox
// inlined) that loads inside a session with no node_modules.
const bridgeExtensionSource = bridgeExtensionBundle();

interface Harness {
  workspace: string;
  manager: SessionManager;
  server: FakeModelServer;
  /**
   * Build another SessionManager on the same workspace + bridge — simulates an agent restart, so a
   * resume test can respawn a session dir that a prior manager wrote.
   */
  makeManager: () => SessionManager;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/**
 * The real SessionManager on the real local() runtime, wired the way agent.ts wires it — bridge
 * token minted per session, resolved pi carried as data, secrets in the spawn env only.
 */
async function startHarness(opts: {
  script: (params: ChatRequest) => ModelAction[];
  tools?: Tool[];
  /**
   * Env var name the fake provider's apiKey references as a "$VAR" in models.json — pi interpolates
   * it from the forwarded spawn env. A literal test key by default.
   */
  apiKeyEnv?: string;
  /**
   * Extra spawn env — where forwarded credential values ride.
   */
  env?: Record<string, string>;
}): Promise<Harness> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "local-int-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

  const server = await startFakeModel(opts.script);
  cleanups.push(() => server.close());

  const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const bridge = new ToolBridge({ tools });
  await bridge.start();
  cleanups.push(() => bridge.stop());

  const makeManager = (): SessionManager => {
    const manager = new SessionManager({
      paths: createAgentPaths(workspace, "test"),
      runtime: local(),
      bridge: { url: bridge.callUrl() },
      prepareSession: ({ cwd }) => {
        // Write the bridge extension so pi discovers it.
        const extDir = path.join(cwd, ".pi", "extensions");
        mkdirSync(extDir, { recursive: true });
        writeFileSync(path.join(extDir, "bridge.js"), readFileSync(bridgeExtensionSource, "utf-8"));
      },
      setupSession: ({ ref }) => {
        const toolSpecs = [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input) as Record<string, unknown>,
        }));
        // A custom provider resolves its key from models.json: a literal by default, or a "$ENV"
        // reference pi interpolates from the forwarded spawn env (how a forwarded credential reaches
        // the model).
        const fakeApiKey = opts.apiKeyEnv ? `$${opts.apiKeyEnv}` : "test-key";
        return {
          pi: {
            model: "fake/fake-1",
            instructions: "You are a test agent.",
            models: {
              providers: {
                fake: {
                  baseUrl: server.url,
                  api: "openai-completions",
                  apiKey: fakeApiKey,
                  models: [{ id: "fake-1" }],
                },
              },
            },
          },
          tools: toolSpecs,
          env: { ...opts.env },
          // The token rides bridge.token → bridge.json (written by the runtime), not the env.
          bridgeToken: bridge.issueToken(ref),
        };
      },
      teardownSession: (ref) => bridge.releaseSession(ref),
    });
    cleanups.push(() => manager.stopAll());
    return manager;
  };

  return { workspace, manager: makeManager(), server, makeManager };
}

describe("local() integration (real worker, real session manager, no jail)", () => {
  test("a keyed session round-trips turns end-to-end: host tool over the bridge, transcript on disk", async () => {
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
    const h = await startHarness({
      tools: [magicWord],
      script: (params) =>
        params.messages.some((m) => m.role === "tool")
          ? [{ text: `The magic word is ${lastToolText(params)}` }]
          : [{ toolCall: { name: "magic_word", args: { flavor: "plain" } } }],
    });

    const sessions = h.manager.namespace("it");
    const turn = sessions.run("chat", "What is the magic word?", { timeoutMs: 60_000 });
    const result = await turn;

    // Host-side execution, zod-validated arg, secret round-trip — through
    // a plain host child process instead of a bwrap jail.
    expect(executed).toEqual([{ flavor: "plain" }]);
    expect(result.text).toContain(SECRET);

    // Real tool names in the manager's event stream (replayed post hoc).
    const events: TurnEvent[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_start", tool: "magic_word" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_end", tool: "magic_word", isError: false }),
    );

    // The manager registered the session…
    expect(h.manager.list()).toContainEqual(
      expect.objectContaining({ ref: { source: "it", key: "chat" } }),
    );
    // …and the worker wrote its transcript flat into the session cwd
    // (--session-dir): {dataDir}/{name}/sessions/{source}/{key}.
    const files = await readdir(path.join(h.workspace, "test", "sessions", "it", "chat"));
    expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);

    // The session survives its turn: the same worker answers again.
    const again = await sessions.run("chat", "Say it again?", { timeoutMs: 60_000 });
    expect(again.text).toContain(SECRET);
    expect(h.manager.list()).toHaveLength(1);
  }, 120_000);

  test("resumes the prior conversation after an involuntary respawn (agent restart)", async () => {
    const requests: ChatRequest[] = [];
    const h = await startHarness({
      script: (params) => {
        requests.push(params);
        return [{ text: "ok" }];
      },
    });

    await h.manager.namespace("it").run("chat", "Remember the codeword: bluejay.", {
      timeoutMs: 60_000,
    });

    // Simulate an involuntary respawn (agent restart): stop the manager — kills the worker, keeps
    // the session dir — then a fresh manager on the same workspace respawns the session.
    await h.manager.stopAll();
    const restarted = h.makeManager();
    await restarted.namespace("it").run("chat", "What was the codeword?", { timeoutMs: 60_000 });

    // The post-respawn model request carries the first turn's message — pi resumed the on-disk
    // transcript (--continue). Without the fix the fresh worker would only see the second prompt.
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("bluejay");
  }, 120_000);

  test("reset (/new) starts a fresh conversation but keeps prior transcripts on disk", async () => {
    const requests: ChatRequest[] = [];
    const h = await startHarness({
      script: (params) => {
        requests.push(params);
        return [{ text: "ok" }];
      },
    });
    const sessions = h.manager.namespace("it");

    await sessions.run("chat", "Remember the codeword: bluejay.", { timeoutMs: 60_000 });
    await h.manager.reset("it", "chat"); // /new
    await sessions.run("chat", "What was the codeword?", { timeoutMs: 60_000 });

    // Fresh: the post-/new request does NOT carry the first turn's message (new pi session).
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("bluejay");
    // Non-destructive: both transcripts (the old one and the new one) remain on disk for /resume.
    const files = await readdir(path.join(h.workspace, "test", "sessions", "it", "chat"));
    expect(files.filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test("SpawnRequest.env reaches the worker: the forwarded credential becomes the model bearer", async () => {
    const h = await startHarness({
      script: () => [{ text: "authed" }],
      apiKeyEnv: "FAKE_PROVIDER_KEY",
      env: { FAKE_PROVIDER_KEY: "s3cret-from-spawn-env" },
    });

    const result = await h.manager.namespace("it").run("auth", "hello", { timeoutMs: 60_000 });

    expect(result.text).toBe("authed");
    // The value travelled spawn-env → worker process → model request.
    // (buildPiArgs keeps it out of argv; the runtime unit tests pin that.)
    expect(h.server.requests[0]!.authorization).toBe("Bearer s3cret-from-spawn-env");
  }, 120_000);
});
