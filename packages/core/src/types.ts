import type { Tool } from "./tools/tool.js";
import type { Turn, TurnEvent, TurnResult } from "./session/turn.js";

// Re-export session types so they're available from the main export
export type { Turn, TurnEvent, TurnResult };

/**
 * The valid thinking levels, in ascending order of effort. The single source of truth: the
 * {@link ThinkingLevel} type is derived from this array.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * One of the valid thinking levels. Derived from {@link THINKING_LEVELS}.
 */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The structured logger the kernel hands to plugins and internal components. Every line carries a
 * timestamp and a scope tag; `data` is appended as trailing detail.
 */
export interface Logger {
  /**
   * Log an informational line. `data` renders as trailing `key=value` pairs.
   */
  log(message: string, data?: Record<string, unknown>): void;
  /**
   * Log a warning line. `data` renders as trailing `key=value` pairs.
   */
  warning(message: string, data?: Record<string, unknown>): void;
  /**
   * Log an error line. `data` accepts anything — an Error renders as its message, other values
   * render as detail.
   */
  error(message: string, data?: unknown): void;
}

// ---------------------------------------------------------------------------
// Runtime

/**
 * Everything a runtime needs to start one session process. Carries only data already intended to be
 * session-visible — the bridge token rides `bridge`, per-session env rides `env` (never argv), and
 * connection credentials never appear at all.
 */
export interface SpawnRequest {
  /**
   * The session identity — owning source and un-namespaced key.
   */
  ref: SessionRef;
  /**
   * Host staging directory — created and seeded (prepareSession hooks ran) before spawn, and the
   * session's working directory (its read-write $HOME under an isolating runtime). Seed-at-spawn is
   * the only guarantee — no live sync, no reverse channel.
   */
  cwd: string;
  /**
   * Host-contributed child environment (per-session env such as a gateway's minted token). The
   * runtime layers its own ambient env on top; the bridge bearer token rides `bridge.token`, not
   * here. No secret rides argv — it's world-readable via /proc.
   */
  env: Record<string, string>;
  /**
   * The fully resolved pi config, written to pi's config files verbatim: host-absolute paths and
   * per-session overrides applied. Session-visible by construction — it carries no credentials
   * (those ride `env`).
   */
  pi: PiOptions;
  /**
   * The host tool manifest served over the bridge — written to the bridge extension's config, not
   * pi's settings. Definitions without the execute function.
   */
  tools?: SessionToolSpec[];
  /**
   * Whether to resume the session's prior conversation (pi `--continue`) or start a new one.
   * Defaults to resuming. The kernel sets it false only after `reset()` (a gateway's `/new`), so a
   * respawn from idle eviction, crash, or agent restart continues where it left off, while `/new`
   * begins a fresh pi session — prior transcripts are kept on disk (for a future `/resume`).
   */
  resume?: boolean;
  /**
   * The tool bridge as the HOST reaches it. The runtime must make it reachable from wherever the
   * session runs (remote runtimes tunnel it) and writes `token` into the session's bridge.json so
   * the bridge extension can authenticate its calls. The token is a per-session, loopback-scoped
   * bearer, revoked at teardown.
   */
  bridge: { url: string; token?: string };
}

export interface RuntimeExecOptions {
  /**
   * Host path mounted read-write as the workdir. The caller creates it before the call and removes
   * it after.
   */
  cwd: string;
  /**
   * Shell command, run via `sh -c`.
   */
  command: string;
  /**
   * Kill the command after this long; the call rejects with a timeout error.
   */
  timeoutMs: number;
}

export interface RuntimeProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): Promise<void>;
  readonly alive: boolean;
  /**
   * Resolves when the process exits (undefined exit code if unknown).
   */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface Runtime {
  name: string;
  /**
   * Called once at startup — fail fast (with fix instructions) if the host can't run sessions.
   */
  check(): Promise<void>;
  /**
   * Spawn a session worker (a pi session). The framework handles the RPC protocol over the returned
   * streams.
   */
  spawn(spec: SpawnRequest): Promise<RuntimeProcess>;
  /**
   * Run a shell command in the runtime and return its combined output (throws on non-zero exit or
   * timeout). Backs ctx.runtime.exec.
   */
  exec(opts: RuntimeExecOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Sessions

/**
 * Identifies one session.
 */
export interface SessionRef {
  /**
   * Owning namespace / origin id ("telegram", "cron", "host").
   */
  source: string;

  /**
   * Local key within the source, un-namespaced.
   */
  key: string;
}

export interface SessionOptions {
  /**
   * Per-session pi overrides, merged over the agent-wide `pi` config. `instructions` concatenates
   * onto the agent-wide instructions (both append to pi's base prompt); every other field replaces.
   * To replace pi's base prompt entirely, set `pi.systemPrompt`.
   */
  pi?: Partial<PiOptions>;

  /**
   * Extra env vars inside this session's process (e.g. a per-session GH_TOKEN). A gateway plugin
   * uses this to inject a dynamically-minted, per-session credential the ambient runtime env can't
   * carry.
   */
  env?: Record<string, string>;

  /**
   * Override the working directory. Default: {dataDir}/{name}/sessions/{source}/{key}.
   */
  cwd?: string;

  /**
   * Tools served ONLY to this session, in addition to agent-wide tools. Bound at session creation;
   * revoked at session teardown. A name collision with an agent-wide tool or within this list is an
   * error thrown at session creation (same strictness as startup).
   */
  tools?: Tool[];
}

/**
 * The person behind a turn, as authenticated by a gateway.
 */
export interface SessionIdentity {
  /**
   * The gateway that authenticated this person, e.g. "telegram".
   */
  source: string;

  /**
   * The user id. Usually a gateway will use the platform's stable id here, e.g. telegram `from.id`
   * or github `sender.id`.
   */
  id: string;

  /**
   * For UX and logs only, never for keying.
   */
  display?: string;
}

export interface TurnOptions {
  /**
   * Abort the turn after this long. Default: 15 minutes.
   */
  timeoutMs?: number;

  /**
   * Who sent the message behind this turn. Gateways attach it on every run. This persists until the
   * next turn starts.
   *
   * If omitted the turn is anonymous (cron, host runs).
   */
  user?: SessionIdentity;
}

/**
 * Options for a one-shot run (agent.run / ctx.run): the turn options plus the session options that
 * shape the fresh session it spins up (per-run model/thinking/instructions live on `pi`).
 */
export interface RunOptions extends TurnOptions, SessionOptions {}

/**
 * Session statistics, including token usage, turn count, and timing.
 */
export interface SessionStats {
  /**
   * Null until the first turn completes.
   */
  tokens: number | null;
  turns: number;
  startedAt: Date;
  lastActiveAt: Date;
}

export interface SessionInfo {
  ref: SessionRef;
  startedAt: Date;
  lastActiveAt: Date;
}

export interface Session {
  /**
   * The session identifier.
   */
  key: string;

  /**
   * The working directory of the session.
   */
  cwd: string;

  /**
   * Run a prompt in the session.
   */
  run(prompt: string, opts?: TurnOptions): Turn;

  /**
   * Get session stats for the session, like number of turns, context used, etc.
   */
  stats(): Promise<SessionStats>;

  /**
   * Reset the session, killing the process and starting fresh.
   */
  reset(): Promise<void>;
}

/**
 * Create and manage sessions, including running turns and resetting.
 */
export interface Sessions {
  /**
   * Get-or-create the session, then run one turn. The `session` options apply only when this call
   * creates the session.
   */
  run(key: string, prompt: string, opts?: TurnOptions & { session?: SessionOptions }): Turn;

  /**
   * Get-or-create without prompting.
   */
  open(key: string, opts?: SessionOptions): Promise<Session>;

  /**
   * Get a session using the session id. Undefined if the session isn't live.
   */
  get(key: string): Session | undefined;

  /**
   * Start a fresh conversation (a gateway's `/new`): kill the live process, and make the next run
   * begin a new pi session instead of resuming. Prior transcripts are kept on disk (for a future
   * `/resume`). Takes effect even if the session isn't currently live.
   */
  reset(key: string): Promise<void>;

  /**
   * List all active sessions.
   */
  list(): SessionInfo[];
}

// ---------------------------------------------------------------------------
// Commands

/**
 * What a gateway hands a plugin command: who typed it, the rest of the command line, and the ways
 * to answer.
 */
export interface CommandContext {
  /**
   * The current unique user.
   */
  user?: SessionIdentity;

  /**
   * Everything after the command name, e.g. "linear" for "/connect linear".
   */
  args: string;

  /**
   * Answer where they typed (possibly a group).
   */
  reply(text: string): Promise<void>;

  /**
   * Answer privately. Omit when the platform has no private channel. Commands that need private
   * delivery refuse with instructions instead.
   */
  dm?(text: string): Promise<void>;
}

/**
 * A slash command contributed by a plugin.
 */
export interface Command {
  name: string;
  description: string;
  handler(ctx: CommandContext): Promise<void>;
}

/**
 * The agent's plugin-command catalogue exposed to gateways.
 */
export interface Commands {
  list(): ReadonlyArray<Pick<Command, "name" | "description">>;
  dispatch(name: string, ctx: CommandContext): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Plugins

/**
 * The session identity plus its working directory, handed to prepareSession.
 */
export interface PrepareSessionInfo {
  ref: SessionRef;
  cwd: string;
}

/**
 * This is what your plugin factory function needs to return.
 */
export interface Plugin {
  /**
   * Unique within one agent. Used for logger scope, session namespace, data dir.
   */
  name: string;

  /**
   * Tools contributed to the agent. Name clashes will throw an error.
   */
  tools?: Tool[];

  /**
   * Slash commands contributed to gateways. Name clashes are construction errors.
   */
  commands?: Command[];

  /**
   * Called once at agent construction, before commands/tools are collected. Receives the agent's
   * data directory and name — use to resolve lazy configuration that depends on paths (e.g. store
   * factories). Throwing an error fails agent creation.
   */
  resolve?(info: { dataDir: string; agentName: string }): void;

  /**
   * Called when the agent is started. You can use this to run additional processes or set up state.
   */
  start?(ctx: PluginContext): void | Promise<void>;

  /**
   * Called when the agent is stopped. You can use this to clean up resources.
   */
  stop?(): void | Promise<void>;

  /**
   * Called before a session this plugin owns starts, after its working directory is set up — use it
   * to seed the session's config dir (e.g. `~/.config/<tool>/config.json`). Runs only for sessions
   * whose `info.ref.source` is this plugin's name (the sessions it created); other plugins' and
   * host sessions are none of its business.
   *
   * Throwing an error will fail the session spawn.
   */
  prepareSession?(info: PrepareSessionInfo): void | Promise<void>;

  /**
   * Like `prepareSession`, but called for every new session after its owning plugin's hook.
   */
  prepareAllSessions?(info: PrepareSessionInfo): void | Promise<void>;

  /**
   * Like `prepareSession`, but called after the session's pi config is resolved, to modify it —
   * e.g. add an MCP server, a skill dir, or a model override. Receives and returns
   * [`PiOptions`](#pioptions). Per-session env is set at `open`/`run` time (`SessionOptions.env`),
   * not here. Runs only for sessions this plugin owns (`session.source` is the plugin's name).
   *
   * A thrown error fails the spawn.
   */
  configureSession?(session: SessionRef, pi: PiOptions): PiOptions;

  /**
   * Modify every session after its owning plugin's configureSession hook.
   */
  configureAllSessions?(session: SessionRef, pi: PiOptions): PiOptions;

  /**
   * Called whenever any session is torn down.
   */
  releaseSession?(session: SessionRef): void;
}

/**
 * The context object passed to plugins that allows them to interact with the agent.
 */
export interface PluginContext {
  /**
   * The agent's display name (`AgentConfig.name`) — for plugins that present the agent to external
   * services or people.
   */
  agentName: string;

  /**
   * Structured logger tagged with the plugin name.
   */
  logger: Logger;

  /**
   * Resolve a path under this plugin's private data directory
   * ({dataDir}/{name}/plugins/{name}/...). Created on first use.
   */
  filePath(...segments: string[]): string;

  /**
   * Run and lookup agent sessions.
   */
  sessions: Sessions;

  /**
   * One-shot: fresh session, one turn, torn down — mirrors agent.run(). cwd defaults to
   * {dataDir}/{name}/sessions/host/{id}.
   */
  run(prompt: string, opts?: RunOptions): Turn;

  /**
   * The narrow runtime slice: exec only, never spawn. `exec` runs a shell command through the
   * runtime in a throwaway workspace and returns its combined output (throws on non-zero exit or
   * timeout). Default timeout: 5 minutes.
   */
  runtime: { exec(command: string, opts?: { timeoutMs?: number }): Promise<string> };

  /**
   * Commands contributed by every plugin. Gateways choose how to expose them.
   */
  commands: Commands;

  /**
   * The session's sticky current-user pin: whoever sent its running or most recent attributed turn.
   */
  currentUser(session: SessionRef): SessionIdentity | undefined;
}

// ---------------------------------------------------------------------------
// Agent config

/**
 * Configuration for the pi harness. This is similar to the settings.json used by Pi when using the
 * CLI.
 */
export interface PiOptions {
  /**
   * The provider and model id, e.g. "anthropic/claude-sonnet-4-5". Custom/local providers are
   * declared in `models`.
   */
  model?: string;

  /**
   * The thinking level, e.g. "off" | "minimal" | "low" | "medium" | "high" | "xhigh".
   */
  thinking?: ThinkingLevel;

  /**
   * Appended to pi's system prompt. (Full replacement: systemPrompt.)
   */
  instructions?: string;

  /**
   * Directories (or files) of pi skills.
   */
  skills?: string[];

  /**
   * Directories of pi prompt templates (slash commands).
   */
  prompts?: string[];

  /**
   * Extensions distributed as packages — written to pi's settings.json `packages` array. This is
   * the primary way to add a published extension. Entries are pi source strings, which pi installs
   * itself at session start: `npm:pi-context-mode@1.2.0`, `git:github.com/user/repo@v1`, and the
   * other pi schemes (`github:`, `http(s):`, `ssh:`). Passed through verbatim.
   *
   * Local, in-repo, or bundled extensions go on `extensions` as absolute file/dir paths, not here.
   */
  packages?: string[];

  /**
   * Replace pi's base system prompt entirely.
   */
  systemPrompt?: string;

  /**
   * Extensions referenced by file path — written to pi's settings.json `extensions` array. For
   * in-repo or bundled extensions you point at directly rather than install: a path to a single
   * file ('./extensions/foo.ts', '/abs/bundle.js') or a directory.
   *
   * Under an isolating runtime the path must be reachable inside the sandbox — the bwrap runtime
   * mounts each extension path read-only. A file-path extension must be self-contained (a bundled
   * file, or a directory carrying its own deps): a mounted file brings no node_modules.
   */
  extensions?: string[];

  /**
   * Custom providers/models — pi's models.json schema, verbatim.
   */
  models?: Record<string, unknown>;

  /**
   * Tool allowlist by name.
   */
  allowedTools?: string[];

  /**
   * Tool denylist by name.
   */
  excludedTools?: string[];

  /**
   * The MCP extension is installed by default. These are the settings to allow external MCP servers
   * to be used.
   */
  mcpServers?: Record<
    string,
    {
      url: string;
      headers?: Record<string, string>;
    }
  >;

  /**
   * Escape hatch: raw pi settings.
   */
  settings?: Record<string, unknown>;
}

/**
 * One host tool as the session worker sees it without the execute function.
 */
export interface SessionToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentConfig {
  /**
   * Display name for logs. The agent's name also scopes its on-disk state: two agents can point at
   * the same dataDir root without their sessions/runs/plugin data colliding.
   */
  name: string;

  /**
   * Root directory for the agent's state. Default: `~/.picco`.
   */
  dataDir?: string;

  /**
   * The pi session every plugin's turns run on: model, thinking, packages, skills, instructions,
   * custom providers, raw settings.
   */
  pi?: PiOptions;

  /**
   * How session processes run — `local()` from `@picco-agent/runtime-local` (no isolation) or bwrap
   * from `@picco-agent/runtime-bwrap` (Linux, bubblewrap isolation).
   */
  runtime: Runtime;

  /**
   * Plugins allow you to extend the agent's capabilities. They can be used to run additional
   * background processes or provide custom tool implementations.
   */
  plugins?: Plugin[];

  /**
   * Ad-hoc tools, merged with plugin tools. Duplicate tool names are a startup error.
   */
  tools?: Tool[];

  /**
   * Session configuration that applies to all runtimes.
   */
  sessions?: {
    /**
     * Evict idle sessions after this long. Disabled by default. Set a duration string (e.g. `"2h"`)
     * or milliseconds to enable.
     */
    idleTimeout?: string | number | false;
    /**
     * Max concurrent one-shot runs (agent.run / ctx.run / cron jobs); excess runs queue FIFO.
     * Default: 10.
     */
    maxRuns?: number;
  };
}

/**
 * The return value from createAgent(). This allows you to run prompts and manage sessions.
 */
export interface AgentHandle {
  /**
   * Start the tool bridge, session manager, and plugins. Installs SIGINT/SIGTERM handlers unless
   * handleSignals: false.
   */
  start(opts?: { handleSignals?: boolean }): Promise<void>;

  /**
   * Stop plugins (reverse order), abort in-flight turns, kill session processes.
   */
  stop(): Promise<void>;

  /**
   * One-shot agent run in a fresh session. Valid only after start().
   */
  run(prompt: string, opts?: RunOptions): Turn;

  /**
   * Host-scoped session namespace — same API plugins get.
   */
  sessions: Sessions;
}
