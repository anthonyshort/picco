import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentPaths } from "../utils/agent-paths.js";
import { silentLogger } from "../utils/logger.js";
import { createTurn, type Turn, type TurnEvent } from "../session/turn.js";
import type { Tool } from "../tools/tool.js";
import type {
  Command,
  CommandContext,
  Commands,
  PluginContext,
  RunOptions,
  Session,
  SessionIdentity,
  SessionInfo,
  SessionOptions,
  SessionRef,
  SessionStats,
  Sessions,
  TurnOptions,
} from "../types.js";

/**
 * A scripted turn outcome: final text plus optional live events and duration.
 */
interface ScriptedResult {
  text: string;
  events?: TurnEvent[];
  durationMs?: number;
}

/**
 * What a scripted reply may return: plain text or a full {@link ScriptedResult}.
 */
type ScriptedReply = string | ScriptedResult;

/**
 * Options for createFakePluginContext.
 */
export interface FakePluginContextOptions {
  /**
   * Source name recorded on turns (default "test").
   */
  source?: string;
  /**
   * Agent display name exposed as ctx.agentName (default "test-agent").
   */
  agentName?: string;
  /**
   * Scripted agent reply. Return a string or `{ text, events?, durationMs? }`.
   */
  reply?: (turn: { key: string | null; prompt: string }) => ScriptedReply | Promise<ScriptedReply>;
  /**
   * Scripted shell for ctx.runtime.exec. Default: `ran: ${command}`. Throw to simulate a failing
   * command.
   */
  exec?: (exec: { command: string; timeoutMs?: number }) => string | Promise<string>;
  /**
   * Token count reported by session stats once a turn has run (default 1234).
   */
  tokens?: number;
  commands?: Command[];
  currentUser?: (session: SessionRef) => SessionIdentity | undefined;
}

/**
 * A PluginContext with recording hooks (turns/execs/sessionTools).
 */
export interface FakePluginContext extends PluginContext {
  /**
   * Every turn any code ran through this context, in order.
   */
  turns: {
    source: string;
    key: string | null;
    prompt: string;
    user?: SessionIdentity;
    session?: SessionOptions;
  }[];
  /**
   * Every ctx.runtime.exec call, in order. Element shape is { command, timeoutMs } here —
   * intentionally not RuntimeExecOptions, unlike FakeRuntime.execs.
   */
  execs: { command: string; timeoutMs?: number }[];
  /**
   * Session-scoped tools, recorded when a session (or one-shot run) binds them. key is null for
   * one-shot runs. Execute them directly to assert behavior.
   */
  sessionTools: { key: string | null; tools: Tool[] }[];
}

interface FakeSessionState {
  key: string;
  cwd: string;
  options?: SessionOptions;
  turns: number;
  startedAt: Date;
  lastActiveAt: Date;
}

/**
 * A fully in-memory PluginContext with recording hooks (turns/execs/sessionTools).
 */
export function createFakePluginContext(opts: FakePluginContextOptions = {}): FakePluginContext {
  const source = opts.source ?? "test";
  const reply = opts.reply ?? (({ prompt }: { prompt: string }) => `echo: ${prompt}`);
  const exec = opts.exec ?? (({ command }: { command: string }) => `ran: ${command}`);
  const tokens = opts.tokens ?? 1234;
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "testctx-"));
  const testPaths = createAgentPaths(baseDir, source);
  const live = new Map<string, FakeSessionState>();
  const turns: FakePluginContext["turns"] = [];
  const execs: FakePluginContext["execs"] = [];
  const sessionTools: FakePluginContext["sessionTools"] = [];
  const commandMap = new Map((opts.commands ?? []).map((command) => [command.name, command]));
  const commands: Commands = {
    list: () => [...commandMap.values()].map(({ name, description }) => ({ name, description })),
    async dispatch(name: string, ctx: CommandContext): Promise<boolean> {
      const command = commandMap.get(name);
      if (!command) return false;
      await command.handler(ctx);
      return true;
    },
  };

  // Mirror the session manager's strictness: duplicate names within one binding
  // throw at session creation. (Collisions with agent-wide tools can't be
  // checked here — the fake context has no agent.)
  function bindTools(key: string | null, tools: Tool[] | undefined): void {
    if (!tools?.length) return;
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Session-scoped tool "${tool.name}" collides with an existing tool`);
      }
      seen.add(tool.name);
    }
    sessionTools.push({ key, tools });
  }

  /**
   * Record the turn and drive it through the scripted reply.
   */
  function runTurn(
    key: string | null,
    prompt: string,
    state?: FakeSessionState,
    user?: SessionIdentity,
    session?: SessionOptions,
  ): Turn {
    turns.push({ source, key, prompt, user, session });
    const controller = createTurn();
    controller.turn.catch(() => {});
    (async () => {
      try {
        const scripted = await reply({ key, prompt });
        const result: ScriptedResult = typeof scripted === "string" ? { text: scripted } : scripted;
        controller.emit({ type: "turn_start" });
        for (const event of result.events ?? []) controller.emit(event);
        controller.emit({ type: "turn_end" });
        if (state) {
          state.turns++;
          state.lastActiveAt = new Date();
        }
        controller.resolve({ text: result.text, durationMs: result.durationMs ?? 1 });
      } catch (err) {
        // Scripted failure — mirror the session manager: reject and reset the session.
        if (state) live.delete(state.key);
        controller.reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return controller.turn;
  }

  /**
   * Get-or-create fake session state, mirroring the session manager's semantics.
   */
  function ensure(key: string, options?: SessionOptions): FakeSessionState {
    let state = live.get(key);
    if (!state) {
      // Session options — including tool bindings — apply only on creation,
      // exactly like the real session manager.
      bindTools(key, options?.tools);
      state = {
        key,
        cwd: options?.cwd ?? testPaths.sessionCwd({ source, key }),
        options,
        turns: 0,
        startedAt: new Date(),
        lastActiveAt: new Date(),
      };
      // The real session manager creates the session cwd before spawning.
      mkdirSync(state.cwd, { recursive: true });
      live.set(key, state);
    }
    return state;
  }

  /**
   * The public Session facade over fake state.
   */
  function handle(state: FakeSessionState): Session {
    return {
      key: state.key,
      cwd: state.cwd,
      run: (prompt: string, turnOpts?: TurnOptions) =>
        runTurn(state.key, prompt, state, turnOpts?.user),
      stats: async (): Promise<SessionStats> => ({
        tokens: state.turns > 0 ? tokens : null,
        turns: state.turns,
        startedAt: state.startedAt,
        lastActiveAt: state.lastActiveAt,
      }),
      reset: async () => {
        live.delete(state.key);
      },
    };
  }

  const sessions: Sessions = {
    run: (key, prompt, runOpts) =>
      runTurn(key, prompt, ensure(key, runOpts?.session), runOpts?.user, runOpts?.session),
    open: async (key, sessionOpts) => handle(ensure(key, sessionOpts)),
    get: (key) => {
      const state = live.get(key);
      return state ? handle(state) : undefined;
    },
    reset: async (key) => {
      live.delete(key);
    },
    list: (): SessionInfo[] =>
      [...live.values()].map((s) => ({
        ref: { source, key: s.key },
        startedAt: s.startedAt,
        lastActiveAt: s.lastActiveAt,
      })),
  };

  return {
    agentName: opts.agentName ?? "test-agent",
    logger: silentLogger(),
    filePath: (...segments: string[]) => {
      const base = testPaths.pluginDir(source);
      mkdirSync(base, { recursive: true });
      return path.join(base, ...segments);
    },
    sessions,
    run: (prompt: string, runOpts?: RunOptions) => {
      bindTools(null, runOpts?.tools);
      return runTurn(null, prompt, undefined, runOpts?.user);
    },
    runtime: {
      exec: async (command: string, runOpts?: { timeoutMs?: number }) => {
        const call = { command, timeoutMs: runOpts?.timeoutMs };
        execs.push(call);
        return exec(call);
      },
    },
    commands,
    currentUser: opts.currentUser ?? (() => undefined),
    turns,
    execs,
    sessionTools,
  };
}
