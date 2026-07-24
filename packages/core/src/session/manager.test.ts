import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRuntime } from "../testing/index.js";
import { createAgentPaths } from "../utils/agent-paths.js";
import { parseDuration, SessionManager, type SessionManagerOptions } from "./manager.js";
import type { TurnEvent } from "./turn.js";
import type { PiOptions, SessionIdentity } from "../types.js";

let workspace: string;
let managers: SessionManager[];

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
  managers = [];
});

afterEach(async () => {
  for (const mgr of managers) await mgr.stopAll();
  rmSync(workspace, { recursive: true, force: true });
});

function manager(runtime: FakeRuntime, opts: Partial<SessionManagerOptions> = {}): SessionManager {
  const mgr = new SessionManager({
    paths: createAgentPaths(workspace, "test"),
    runtime,
    readyDelayMs: 0,
    requestTimeoutMs: 1000,
    ...opts,
  });
  managers.push(mgr);
  return mgr;
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("parseDuration", () => {
  test("parses units and numbers", () => {
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration("1500ms")).toBe(1500);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  test("rejects junk", () => {
    expect(() => parseDuration("soon")).toThrow("Invalid duration");
  });
});

describe("SessionManager", () => {
  test("lazily spawns the session worker in the session cwd", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("telegram");

    const result = await sessions.run("42-general", "hello");

    expect(result.text).toBe("echo: hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(runtime.spawns).toHaveLength(1);
    const { spec } = runtime.spawns[0]!;
    expect(spec.ref).toEqual({ source: "telegram", key: "42-general" });
    expect(spec.cwd).toBe(path.resolve(workspace, "test", "sessions", "telegram", "42-general"));
    // No setupSession → an empty resolved pi config and a blank bridge.
    expect(spec.pi).toEqual({});
    expect(spec.bridge).toEqual({ url: "" });
  });

  test("the spawn spec carries the resolved pi and bridge; the token rides env, never pi", async () => {
    const runtime = new FakeRuntime();
    const mgr = manager(runtime, {
      bridge: { url: "http://127.0.0.1:7777/call" },
      setupSession: () => ({
        pi: {
          model: "anthropic/claude-sonnet-4-5",
          instructions: "be kind",
          auth: { anthropic: { env: "ANTHROPIC_API_KEY" } },
        },
        env: { BRIDGE_TOKEN: "tok-sekret" },
      }),
    });

    await mgr.namespace("telegram").run("42", "hi");

    const { spec } = runtime.spawns[0]!;
    expect(spec.bridge).toEqual({ url: "http://127.0.0.1:7777/call" });
    expect(spec.pi).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      instructions: "be kind",
      auth: { anthropic: { env: "ANTHROPIC_API_KEY" } },
    });
    expect(spec.env.BRIDGE_TOKEN).toBe("tok-sekret");
    // The spec's pi config may end up in argv — the secret must not be in it.
    expect(JSON.stringify(spec.pi)).not.toContain("tok-sekret");
  });

  test("turn brackets events and forwards tool/text events from the RPC stream", async () => {
    const runtime = new FakeRuntime({
      eventsFor: () => [
        { type: "tool_execution_start", toolName: "read", toolCallId: "t1" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi " },
        },
        { type: "tool_execution_end", toolName: "read", toolCallId: "t1", isError: false },
      ],
    });
    const sessions = manager(runtime).namespace("slack");

    const turn = sessions.run("c1", "go");
    const events = await collect(turn.events);
    await turn;

    expect(events).toEqual([
      { type: "turn_start" },
      { type: "tool_start", tool: "read", toolCallId: "t1" },
      { type: "text", text: "hi " },
      { type: "tool_end", tool: "read", toolCallId: "t1", isError: false },
      { type: "turn_end" },
    ]);
  });

  test("prompts to the same key run FIFO on one session process", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("telegram");

    const [a, b] = await Promise.all([sessions.run("42", "first"), sessions.run("42", "second")]);

    expect(a.text).toBe("echo: first");
    expect(b.text).toBe("echo: second");
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0]!.process.prompts).toEqual(["first", "second"]);
  });

  test("prompts to different keys run on separate session processes", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("telegram");

    await Promise.all([sessions.run("1", "a"), sessions.run("2", "b")]);

    expect(runtime.spawns).toHaveLength(2);
  });

  test("plugins are namespaced — same key, separate sessions and cwds", async () => {
    const runtime = new FakeRuntime();
    const mgr = manager(runtime);

    await mgr.namespace("telegram").run("42", "a");
    await mgr.namespace("github").run("42", "b");

    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[0]!.spec.cwd).toContain(path.join("sessions", "telegram", "42"));
    expect(runtime.spawns[1]!.spec.cwd).toContain(path.join("sessions", "github", "42"));
  });

  test("session options apply only when the call creates the session", async () => {
    const runtime = new FakeRuntime();
    const systems: (string | undefined)[] = [];
    const sessions = manager(runtime, {
      setupSession: ({ pi }) => {
        systems.push(pi?.instructions);
      },
    }).namespace("email");

    await sessions.run("t1", "a", { session: { pi: { instructions: "EMAIL RULES" } } });
    await sessions.run("t1", "b", { session: { pi: { instructions: "OTHER RULES" } } });

    expect(runtime.spawns).toHaveLength(1);
    expect(systems).toEqual(["EMAIL RULES"]);
  });

  test("prepareSession runs with the cwd created, before setupSession", async () => {
    const runtime = new FakeRuntime();
    const calls: string[] = [];
    let prepared: { ref: { source: string; key: string }; cwd: string } | undefined;
    const sessions = manager(runtime, {
      prepareSession: (info) => {
        calls.push("prepare");
        prepared = info;
        expect(existsSync(info.cwd)).toBe(true);
      },
      setupSession: () => {
        calls.push("setup");
      },
    }).namespace("telegram");

    await sessions.run("chat-1", "hi");

    expect(calls).toEqual(["prepare", "setup"]);
    expect(prepared).toEqual({
      ref: { source: "telegram", key: "chat-1" },
      cwd: path.join(workspace, "test", "sessions", "telegram", "chat-1"),
    });
  });

  test("a throwing prepareSession fails the spawn (the turn rejects)", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime, {
      prepareSession: () => {
        throw new Error("seed write failed");
      },
    }).namespace("telegram");

    await expect(sessions.run("chat-1", "hi")).rejects.toThrow("seed write failed");
    expect(runtime.spawns).toHaveLength(0);
  });

  test("per-session env merges over the base env (bare-manager fallback)", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime, {
      env: { ANTHROPIC_API_KEY: "base-key", GH_TOKEN: "base-token" },
    }).namespace("github");

    await sessions.run("r-pr-1", "go", { session: { env: { GH_TOKEN: "tok123" } } });

    expect(runtime.spawns[0]!.spec.env).toEqual({
      ANTHROPIC_API_KEY: "base-key",
      GH_TOKEN: "tok123", // per-session override wins
    });
  });

  test("setupSession receives the per-session env; a setup-provided env is the complete spawn environment", async () => {
    const runtime = new FakeRuntime();
    const seen: (Record<string, string> | undefined)[] = [];
    const sessions = manager(runtime, {
      env: { BASE: "excluded" },
      setupSession: ({ env }) => {
        seen.push(env);
        return { pi: {}, env: { ONLY: "this" } };
      },
    }).namespace("github");

    await sessions.run("pr-1", "go", { session: { env: { GH_TOKEN: "tok" } } });

    expect(seen).toEqual([{ GH_TOKEN: "tok" }]);
    // The agent host's fold owns the whole environment — no base/per-session
    // merge on top of what setupSession returns.
    expect(runtime.spawns[0]!.spec.env).toEqual({ ONLY: "this" });
  });

  test("a failed turn rejects and auto-resets: the next run gets a fresh session process", async () => {
    const runtime = new FakeRuntime((i) => (i === 0 ? { dieOnPrompt: true } : {}));
    const sessions = manager(runtime).namespace("github");

    await expect(sessions.run("pr-1", "first")).rejects.toThrow();
    const result = await sessions.run("pr-1", "second");

    expect(result.text).toBe("echo: second");
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[0]!.process.killed).toBe(true);
  });

  test("a turn timeout rejects and resets the session", async () => {
    const runtime = new FakeRuntime((i) => (i === 0 ? { neverFinish: true } : {}));
    const sessions = manager(runtime).namespace("telegram");

    await expect(sessions.run("42", "slow", { timeoutMs: 30 })).rejects.toThrow("Prompt timed out");
    const result = await sessions.run("42", "next");

    expect(result.text).toBe("echo: next");
    expect(runtime.spawns).toHaveLength(2);
  });

  test("queued turns still run (fresh process) after the turn ahead of them fails", async () => {
    const runtime = new FakeRuntime((i) => (i === 0 ? { dieOnPrompt: true } : {}));
    const sessions = manager(runtime).namespace("telegram");

    const first = sessions.run("42", "boom");
    const second = sessions.run("42", "after");

    await expect(first).rejects.toThrow();
    expect((await second).text).toBe("echo: after");
    expect(runtime.spawns).toHaveLength(2);
  });

  test("abort() rejects the awaited turn", async () => {
    const runtime = new FakeRuntime({ neverFinish: true });
    const sessions = manager(runtime).namespace("slack");

    const turn = sessions.run("c1", "long task");
    // Give the prompt a beat to get in flight, then abort.
    await new Promise((r) => setTimeout(r, 10));
    turn.abort("user cancelled");

    await expect(turn).rejects.toThrow("Turn aborted: user cancelled");
  });

  test("reset() kills the session process; the next run starts fresh", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("telegram");

    await sessions.run("42", "a");
    await sessions.reset("42");
    await sessions.run("42", "b");

    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[0]!.process.killed).toBe(true);
  });

  test("reset() is a no-op for sessions that aren't live", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("telegram");
    await expect(sessions.reset("nope")).resolves.toBeUndefined();
  });

  test("open() spawns without prompting and returns a handle with the cwd", async () => {
    const runtime = new FakeRuntime();
    const sessions = manager(runtime).namespace("github");

    const session = await sessions.open("pr-7", { env: { GH_TOKEN: "t" } });

    expect(session.key).toBe("pr-7");
    expect(session.cwd).toBe(path.resolve(workspace, "test", "sessions", "github", "pr-7"));
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0]!.process.prompts).toHaveLength(0);

    const result = await session.run("now go");
    expect(result.text).toBe("echo: now go");
    expect(runtime.spawns).toHaveLength(1); // reused
  });

  test("get() returns a handle only while live; stats reports usage and turns", async () => {
    const runtime = new FakeRuntime({ tokens: 777 });
    const sessions = manager(runtime).namespace("telegram");

    expect(sessions.get("42")).toBeUndefined();
    await sessions.run("42", "a");
    await sessions.run("42", "b");

    const stats = await sessions.get("42")!.stats();
    expect(stats.tokens).toBe(777);
    expect(stats.turns).toBe(2);
    expect(stats.startedAt).toBeInstanceOf(Date);
  });

  test("list() is scoped per namespace; runtime.list() sees everything", async () => {
    const runtime = new FakeRuntime();
    const mgr = manager(runtime);
    await mgr.namespace("telegram").run("42", "a");
    await mgr.namespace("github").run("pr-1", "b");

    expect(mgr.namespace("telegram").list()).toMatchObject([
      { ref: { key: "42", source: "telegram" } },
    ]);
    expect(mgr.list()).toHaveLength(2);
  });

  test("idle sessions are evicted after the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime();
      const mgr = manager(runtime, { idleTimeout: "2h" });
      const sessions = mgr.namespace("telegram");

      const turn = sessions.run("42", "a");
      await vi.advanceTimersByTimeAsync(5);
      await turn;
      expect(mgr.list()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(parseDuration("2h") + parseDuration("2m"));

      expect(mgr.list()).toHaveLength(0);
      expect(runtime.spawns[0]!.process.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("idleTimeout: false disables eviction", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime();
      const mgr = manager(runtime, { idleTimeout: false });
      const turn = mgr.namespace("telegram").run("42", "a");
      await vi.advanceTimersByTimeAsync(5);
      await turn;

      await vi.advanceTimersByTimeAsync(parseDuration("6h"));

      expect(mgr.list()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("runOnce spawns a fresh session under sessions/host/ and tears it down", async () => {
    const runtime = new FakeRuntime();
    const mgr = manager(runtime);

    const turn = mgr.runOnce("cron", "do the thing");
    const events = await collect(turn.events);
    const result = await turn;

    expect(result.text).toBe("echo: do the thing");
    expect(events[0]).toEqual({ type: "turn_start" });
    expect(events.at(-1)).toEqual({ type: "turn_end" });
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0]!.spec.cwd).toContain(path.join(workspace, "test", "sessions", "host"));
    expect(runtime.spawns[0]!.process.killed).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });

  test("runOnce honors cwd and hands its pi override + env to setupSession", async () => {
    const runtime = new FakeRuntime();
    const setups: { pi?: Partial<PiOptions>; env?: Record<string, string> }[] = [];
    const mgr = manager(runtime, {
      setupSession: ({ pi, env }) => {
        setups.push({ pi, env });
      },
    });
    const cwd = path.join(workspace, "custom-run");

    await mgr.runOnce("cron", "go", {
      cwd,
      pi: { model: "override/model", thinking: "high", instructions: "CRON RULES" },
      env: { JOB_ID: "42" },
    });

    expect(runtime.spawns[0]!.spec.cwd).toBe(cwd);
    expect(setups).toEqual([
      {
        pi: { model: "override/model", thinking: "high", instructions: "CRON RULES" },
        env: { JOB_ID: "42" },
      },
    ]);
  });

  test("one-shot runs above maxRuns queue FIFO until a slot frees", async () => {
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };
    // Gates are keyed by prompt: "a" and "b" spawn concurrently, so their
    // prompts can arrive in either order.
    const gates = new Map<string, () => void>();
    const runtime = new FakeRuntime({
      reply: (prompt) =>
        new Promise<string>((resolve) => gates.set(prompt, () => resolve(`done: ${prompt}`))),
    });
    const mgr = manager(runtime, { maxRuns: 2 });

    const first = mgr.runOnce("cron", "a");
    const second = mgr.runOnce("cron", "b");
    const third = mgr.runOnce("cron", "c");

    // Two runs get in flight; the third stays queued — no third spawn.
    await until(() => gates.size === 2);
    expect(runtime.spawns).toHaveLength(2);
    expect(gates.has("c")).toBe(false);

    gates.get("a")!(); // finish "a" → its slot goes to "c"
    expect((await first).text).toBe("done: a");
    await until(() => runtime.spawns.length === 3 && gates.has("c"));

    gates.get("b")!();
    gates.get("c")!();
    expect((await second).text).toBe("done: b");
    expect((await third).text).toBe("done: c");
  });

  test("a worker that exits before the ready check surfaces stderr with the execvp hint", async () => {
    const runtime = new FakeRuntime({
      exitOnSpawn: { code: 1, stderr: "bwrap: execvp pi: No such file or directory" },
    });
    const sessions = manager(runtime, { readyDelayMs: 5 }).namespace("telegram");

    await expect(sessions.run("42", "hi")).rejects.toThrow(
      /session worker exited prematurely.*command not found inside the session environment/s,
    );
  });

  test("a module-not-found worker death teaches the node_modules mount rule", async () => {
    const runtime = new FakeRuntime({
      exitOnSpawn: {
        code: 1,
        stderr: "error: Cannot find module '@earendil-works/pi-coding-agent' from worker.ts",
      },
    });
    const sessions = manager(runtime, { readyDelayMs: 5 }).namespace("telegram");

    await expect(sessions.run("42", "hi")).rejects.toThrow(
      /extension's dependency is not visible inside the session.*bundle.*bwrap\(\{ mounts \}\)/s,
    );
  });

  test("stopAll kills every live session and refuses new work", async () => {
    const runtime = new FakeRuntime();
    const mgr = manager(runtime);
    const sessions = mgr.namespace("telegram");
    await sessions.run("1", "a");
    await sessions.run("2", "b");

    await mgr.stopAll();

    expect(runtime.spawns[0]!.process.killed).toBe(true);
    expect(runtime.spawns[1]!.process.killed).toBe(true);
    await expect(sessions.run("1", "again")).rejects.toThrow("stopped");
  });

  test("setupSession runs before spawn, after the session cwd exists", async () => {
    const runtime = new FakeRuntime();
    const setups: string[] = [];
    const mgr = manager(runtime, {
      setupSession: async ({ ref, cwd }) => {
        expect(runtime.spawns).toHaveLength(0);
        setups.push(`${ref.source}/${ref.key}:${cwd}`);
      },
    });

    await mgr.namespace("telegram").run("42", "hi");

    expect(setups).toEqual([
      `telegram/42:${path.resolve(workspace, "test", "sessions", "telegram", "42")}`,
    ]);
    expect(runtime.spawns).toHaveLength(1);
  });

  describe("current-user pin", () => {
    const userA = { source: "telegram", id: "123" };
    const userB = { source: "telegram", id: "456" };

    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };

    test("the pin is set before the session process spawns on a session's first turn", async () => {
      const runtime = new FakeRuntime();
      const pinsAtSetup: (SessionIdentity | undefined)[] = [];
      const mgr = manager(runtime, {
        setupSession: ({ ref }) => {
          pinsAtSetup.push(mgr.currentUser(ref.source, ref.key));
        },
      });

      await mgr.namespace("telegram").run("42", "hi", { user: userA });

      expect(pinsAtSetup).toEqual([userA]);
    });

    test("with queued turns A then B, the pin reads A for the whole of A's turn (FIFO)", async () => {
      // Gate each turn mid-flight so the pin is observable while it runs.
      const gates = new Map<string, () => void>();
      const runtime = new FakeRuntime({
        reply: (prompt) =>
          new Promise<string>((resolve) => gates.set(prompt, () => resolve(`done: ${prompt}`))),
      });
      const mgr = manager(runtime);
      const sessions = mgr.namespace("telegram");

      const turnA = sessions.run("42", "from-a", { user: userA });
      const turnB = sessions.run("42", "from-b", { user: userB });

      // A is in flight, B is queued behind it — the pin is A, not B.
      await until(() => gates.has("from-a"));
      expect(gates.has("from-b")).toBe(false);
      expect(mgr.currentUser("telegram", "42")).toEqual(userA);

      gates.get("from-a")!();
      await turnA;

      // Only when B's turn dequeues does the pin become B.
      await until(() => gates.has("from-b"));
      expect(mgr.currentUser("telegram", "42")).toEqual(userB);

      gates.get("from-b")!();
      await turnB;
    });

    test("the pin is sticky: it remains set between turns (last sender)", async () => {
      const runtime = new FakeRuntime();
      const mgr = manager(runtime);

      await mgr.namespace("telegram").run("42", "hi", { user: userA });

      expect(mgr.currentUser("telegram", "42")).toEqual(userA);
    });

    test("turns with no user leave the previous pin intact", async () => {
      const runtime = new FakeRuntime();
      const mgr = manager(runtime);
      const sessions = mgr.namespace("telegram");

      await sessions.run("42", "attributed", { user: userA });
      await sessions.run("42", "anonymous");

      expect(mgr.currentUser("telegram", "42")).toEqual(userA);
    });

    test("unknown sessions have no pin", () => {
      const mgr = manager(new FakeRuntime());
      expect(mgr.currentUser("telegram", "never-ran")).toBeUndefined();
    });
  });

  test("teardownSession fires on reset, failure, and stopAll", async () => {
    const runtime = new FakeRuntime((i) => (i === 1 ? { dieOnPrompt: true } : {}));
    const teardowns: string[] = [];
    const mgr = manager(runtime, {
      teardownSession: ({ source, key }) => teardowns.push(`${source}/${key}`),
    });
    const sessions = mgr.namespace("telegram");

    await sessions.run("a", "hi");
    await sessions.reset("a"); // teardown 1
    await sessions.run("a", "boom").catch(() => {}); // failed turn → teardown 2
    await sessions.run("b", "hi");
    await mgr.stopAll(); // teardown 3 (b)

    expect(teardowns).toEqual(["telegram/a", "telegram/a", "telegram/b"]);
  });
});
