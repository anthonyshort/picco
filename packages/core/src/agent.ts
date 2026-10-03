import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { createAgentPaths, generateSessionId } from "./utils/agent-paths.js";
import type { AgentPaths } from "./utils/agent-paths.js";
import { ToolBridge } from "./tools/bridge.js";
import { createLogger } from "./utils/logger.js";
import { SessionManager } from "./session/manager.js";
import type { Tool } from "./tools/tool.js";
import type { Turn } from "./session/turn.js";
import type {
  AgentConfig,
  AgentHandle,
  Command,
  Commands,
  PiOptions,
  Plugin,
  PluginContext,
  RunOptions,
  Sessions,
} from "./types.js";

/**
 * Reserved namespace for agent.sessions / agent.run (not usable by plugins).
 */
const HOST = "host";

/**
 * Default agent data directory, used when `config.dataDir` is omitted.
 */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), ".picco");

/**
 * Ctx.runtime.exec's default timeout.
 */
const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000;

/**
 * Core-owned extensions bundled with core, injected into every session as file-path extensions.
 * Each is a self-contained bundle (dependencies inlined) resolved from core's own dependencies, so
 * it loads in every runtime with no node_modules. To add another, publish a bundled package whose
 * default export (`.`) is its built bundle (see docs/guides/extensions.md), add it as a dependency
 * of core, and list its name here.
 */
const BUNDLED_EXTENSIONS = ["@picco-agent/bridge-extension"];

/**
 * Resolve a bundled extension package to the absolute path of its built entry — its default export
 * (`.`), which for a bundled pi extension is the self-contained bundle. Realpathed so a jailing
 * runtime binds the real file, not a node_modules symlink. Throws at start() if the package is
 * missing or its bundle has not been built.
 */
function resolveBundledExtensionFile(name: string): string {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(name));
  } catch {
    throw new Error(
      `Bundled extension "${name}" could not be resolved — reinstall (pnpm install) and make sure ` +
        `its bundle is built (a "prepare" build runs on install)`,
    );
  }
  if (!existsSync(entry)) {
    throw new Error(`Bundled extension "${name}": built entry not found at ${entry}`);
  }
  return realpathSync(entry);
}

/**
 * Build an AgentHandle from config. Validation happens here; nothing spawns or listens until
 * start().
 */
export function createAgent(config: AgentConfig): AgentHandle {
  const name = config.name;
  const paths: AgentPaths = createAgentPaths(config.dataDir ?? DEFAULT_DATA_DIR, name);
  const logger = createLogger(name);
  const plugins = config.plugins ?? [];
  const runtime = config.runtime;

  validatePluginNames(plugins);

  // Resolve lazy plugin configuration (e.g. store factories) before commands/tools are collected.
  for (const plugin of plugins) {
    plugin.resolve?.({ dataDir: paths.root, agentName: name });
  }

  const commands = collectCommands(plugins);

  const tools = collectTools(config, plugins);

  let manager: SessionManager | null = null;
  let bridge: ToolBridge | null = null;
  let started = false;
  let signalHandler: ((signal: string) => void) | null = null;
  const startedPlugins: Plugin[] = [];

  function ensureManager(): SessionManager {
    if (!manager) throw new Error("Agent is not started — call agent.start() first");
    return manager;
  }

  /**
   * Run a shell command through the runtime in a throwaway workspace.
   */
  async function exec(command: string, opts?: { timeoutMs?: number }): Promise<string> {
    const id = generateSessionId();
    const cwd = paths.runCwd(id);
    await mkdir(cwd, { recursive: true });
    try {
      return await runtime.exec({
        cwd,
        command,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Creates the context object passed to plugins.
   */
  function pluginContext(pluginName: string): PluginContext {
    return {
      agentName: config.name,
      logger: createLogger(pluginName),
      filePath(...segments: string[]): string {
        const base = paths.pluginDir(pluginName);
        mkdirSync(base, { recursive: true });
        return path.join(base, ...segments);
      },
      sessions: createPluginSessions(pluginName),
      run: (prompt, opts) => ensureManager().runOnce(pluginName, prompt, opts),
      runtime: { exec },
      commands,
      currentUser: (session) => manager?.currentUser(session.source, session.key),
    };
  }

  /**
   * Sessions object passed to the plugins.
   */
  function createPluginSessions(pluginName: string): Sessions {
    const ns = () => ensureManager().namespace(pluginName);
    return {
      run: (key, prompt, opts) => ns().run(key, prompt, opts),
      open: (key, opts) => ns().open(key, opts),
      get: (key) => ns().get(key),
      reset: (key) => ns().reset(key),
      list: () => ns().list(),
    };
  }

  /**
   * Start the agent, plugins, and runtime.
   */
  async function start(opts: { handleSignals?: boolean } = {}): Promise<void> {
    if (started) throw new Error("Agent already started");
    started = true;

    try {
      await startInner(opts);
    } catch (err) {
      // A failed startup (port in use, plugin crash) must not leave the
      // earlier plugins running headless — unwind what already started.
      logger.error("startup failed, stopping", err);
      await stop().catch(() => {});
      throw err;
    }
  }

  /**
   * The actual startup sequence
   */
  async function startInner(opts: { handleSignals?: boolean }): Promise<void> {
    await runtime.check();
    await mkdir(paths.root, { recursive: true });

    // Core's bundled extensions ride the extensions list as file paths — each
    // resolved to the self-contained bundle its package declares in pi.extensions.
    const bundledExtensionFiles = BUNDLED_EXTENSIONS.map(resolveBundledExtensionFile);

    // The tool bridge allows sessions to execute tools via HTTP
    // without exposing the environment or secrets to the agent.
    bridge = new ToolBridge({
      tools,
      logger: createLogger(`${name}:bridge`),
      currentUser: (ref) => manager?.currentUser(ref.source, ref.key),
    });
    await bridge.start();

    // The session manager handles creating new Pi sessions and coordinates
    // the tool bridge and the runtime.
    manager = new SessionManager({
      paths,
      runtime,
      logger: createLogger(`${name}:sessions`),
      bridge: { url: bridge.callUrl() },
      idleTimeout: config.sessions?.idleTimeout,
      maxRuns: config.sessions?.maxRuns,
      prepareSession: async (info) => {
        // The owner prepares first, followed by every plugin's global hook.
        for (const plugin of plugins) {
          if (info.ref.source !== plugin.name) continue;
          await plugin.prepareSession?.(info);
        }
        for (const plugin of plugins) await plugin.prepareAllSessions?.(info);
      },
      setupSession: ({ ref, tools: sessionTools, pi: piOverride, env }) => {
        // Merge per-session pi overrides onto the agent-wide config, then resolve
        // the path-valued fields (packages are pi source strings — passed verbatim).
        const merged = mergePi(config.pi, piOverride);
        let pi: PiOptions = {
          ...merged,
          skills: resolveDirs(merged.skills),
          prompts: resolveDirs(merged.prompts),
          extensions: resolveDirs(merged.extensions),
        };

        // Fold the owning plugin's configureSession hook, then every plugin's global hook. The
        // hooks transform pi only; per-session env rides `env`, untouched by the fold.
        for (const plugin of plugins) {
          if (!plugin.configureSession) continue;
          if (ref.source !== plugin.name) continue;
          pi = plugin.configureSession(ref, pi) ?? pi;
        }
        for (const plugin of plugins) {
          if (!plugin.configureAllSessions) continue;
          pi = plugin.configureAllSessions(ref, pi) ?? pi;
        }

        const allTools = [...tools.values(), ...(sessionTools ?? [])];
        const toolSpecs = allTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input) as Record<string, unknown>,
        }));

        // Append core's bundled extensions after the fold.
        pi = {
          ...pi,
          extensions: [...(pi.extensions ?? []), ...bundledExtensionFiles],
        };

        // The caller's per-session env (e.g. a gateway's minted GH_TOKEN); static env is a
        // runtime-ambient concern. The bridge token is a per-session secret carried on the spec's
        // bridge field and written to bridge.json, never into the env.
        return {
          pi,
          env: { ...env },
          tools: toolSpecs,
          bridgeToken: bridge!.issueToken(ref, sessionTools),
        };
      },
      teardownSession: (ref) => {
        bridge?.releaseSession(ref);
        for (const plugin of [...plugins].reverse()) {
          try {
            plugin.releaseSession?.(ref);
          } catch (err) {
            logger.error("plugin session release failed", { plugin: plugin.name, error: err });
          }
        }
      },
    });

    for (const plugin of plugins) {
      await plugin.start?.(pluginContext(plugin.name));
      startedPlugins.push(plugin);
      logger.log("plugin started", { plugin: plugin.name });
    }

    if (opts.handleSignals !== false) {
      signalHandler = (signal: string) => {
        logger.log(`shutting down (${signal})`);
        stop()
          .catch((err) => logger.error("shutdown failed", err))
          .finally(() => process.exit(0));
      };
      process.once("SIGINT", signalHandler);
      process.once("SIGTERM", signalHandler);
    }

    logger.log("started", {
      root: paths.root,
      plugins: plugins.map((p) => p.name).join(",") || "(none)",
      tools: tools.size,
      runtime: runtime.name,
    });
  }

  async function stop(): Promise<void> {
    if (signalHandler) {
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
      signalHandler = null;
    }

    // Mark the manager stopped and tear sessions down while plugin services are still alive.
    await manager?.stopAll();
    manager = null;

    for (const plugin of [...startedPlugins].reverse()) {
      try {
        await plugin.stop?.();
      } catch (err) {
        logger.error("plugin stop failed", { plugin: plugin.name, error: err });
      }
    }
    startedPlugins.length = 0;

    await bridge?.stop();
    bridge = null;
    started = false;
    logger.log("stopped");
  }

  return {
    start,
    stop,
    run(prompt: string, opts?: RunOptions): Turn {
      return ensureManager().runOnce(HOST, prompt, opts);
    },
    sessions: createPluginSessions(HOST),
  };
}

/**
 * Merge per-session pi overrides onto the agent-wide pi config. `instructions` concatenates (both
 * append to pi's base prompt); every other field replaces. To replace pi's base prompt entirely, an
 * override sets `systemPrompt`.
 */
function mergePi(base: PiOptions | undefined, override: Partial<PiOptions> | undefined): PiOptions {
  return {
    ...base,
    ...override,
    instructions:
      [base?.instructions, override?.instructions].filter(Boolean).join("\n\n") || undefined,
  };
}

/**
 * Resolve a pi path list (skills/prompts/extensions directories) to absolute paths. Empty stays
 * empty — pi still loads skills/prompts/extensions from its default locations regardless.
 */
function resolveDirs(dirs: string[] | undefined): string[] {
  return (dirs ?? []).map((dir) => path.resolve(dir));
}

/**
 * Reject missing, reserved, or duplicate plugin names at construction.
 */
function validatePluginNames(plugins: Plugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.name) throw new Error("Every plugin needs a name");
    if (plugin.name === HOST) throw new Error(`Plugin name "${HOST}" is reserved`);
    if (seen.has(plugin.name)) throw new Error(`Duplicate plugin name "${plugin.name}"`);
    seen.add(plugin.name);
  }
}

/**
 * Register one tool, rejecting name collisions and non-object schemas.
 */
function addTool(tools: Map<string, Tool>, tool: Tool, contributor: string): void {
  if (tools.has(tool.name)) {
    throw new Error(`Duplicate tool name "${tool.name}" (contributed by ${contributor})`);
  }
  if (!(tool.input instanceof z.ZodObject)) {
    throw new Error(`Tool "${tool.name}": input must be a z.object(...) schema`);
  }
  tools.set(tool.name, tool);
}

/**
 * Collect all tools from the config and plugins, ensuring no duplicates.
 */
function collectTools(config: AgentConfig, plugins: Plugin[]): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  for (const tool of config.tools ?? []) addTool(tools, tool, "config.tools");
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) addTool(tools, tool, `plugin "${plugin.name}"`);
  }
  return tools;
}

/**
 * Collect plugin commands and reject ambiguous names.
 */
function collectCommands(plugins: Plugin[]): Commands {
  const commands = new Map<string, Command>();
  for (const plugin of plugins) {
    for (const command of plugin.commands ?? []) {
      if (!command.name)
        throw new Error(`Plugin "${plugin.name}" contributed an empty command name`);
      if (commands.has(command.name)) {
        throw new Error(
          `Duplicate command name "${command.name}" (contributed by plugin "${plugin.name}")`,
        );
      }
      commands.set(command.name, command);
    }
  }
  return {
    list: () => [...commands.values()].map(({ name, description }) => ({ name, description })),
    async dispatch(name, ctx) {
      const command = commands.get(name);
      if (!command) return false;
      await command.handler(ctx);
      return true;
    },
  };
}
