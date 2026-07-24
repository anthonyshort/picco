import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as z from "zod";
import { FakeRuntime, type FakeSpawn } from "./testing/index.js";
import { createAgent } from "./agent.js";
import { tool } from "./tools/tool.js";
import type { AgentConfig, AgentHandle, Plugin, PluginContext } from "./types.js";

let workspace: string;
let agents: AgentHandle[];

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  agents = [];
});

afterEach(async () => {
  for (const agent of agents) await agent.stop().catch(() => {});
  rmSync(workspace, { recursive: true, force: true });
});

function agentWith(config: Partial<AgentConfig> & { runtime?: FakeRuntime }) {
  const { runtime = new FakeRuntime(), ...rest } = config;
  const agent = createAgent({ name: "agent", dataDir: workspace, runtime, ...rest });
  agents.push(agent);
  return { agent, runtime };
}

describe("createAgent", () => {
  describe("validation", () => {
    test("duplicate tool names are a startup error", () => {
      const a = tool({ name: "x", description: "d", input: z.object({}), execute: () => "" });
      const b = tool({ name: "x", description: "d", input: z.object({}), execute: () => "" });
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          tools: [a, b],
        }),
      ).toThrow('Duplicate tool name "x"');
    });

    test("plugin tool colliding with config tool is a startup error", () => {
      const a = tool({ name: "x", description: "d", input: z.object({}), execute: () => "" });
      const plugin: Plugin = { name: "p", tools: [a] };
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          tools: [a],
          plugins: [plugin],
        }),
      ).toThrow('Duplicate tool name "x"');
    });

    test("duplicate plugin names and the reserved host name are startup errors", () => {
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          plugins: [{ name: "p" }, { name: "p" }],
        }),
      ).toThrow('Duplicate plugin name "p"');
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          plugins: [{ name: "host" }],
        }),
      ).toThrow("reserved");
    });

    test("duplicate and empty plugin command names are construction errors", () => {
      const command = { name: "status", description: "Status", handler: async () => {} };
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          plugins: [
            { name: "a", commands: [command] },
            { name: "b", commands: [command] },
          ],
        }),
      ).toThrow('Duplicate command name "status"');
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          plugins: [
            {
              name: "a",
              commands: [{ ...command, name: "" }],
            },
          ],
        }),
      ).toThrow("empty command name");
    });

    test("non-object tool input is a startup error", () => {
      const bad = tool({ name: "x", description: "d", input: z.string(), execute: () => "" });
      expect(() =>
        createAgent({
          name: "agent",
          dataDir: workspace,
          runtime: new FakeRuntime(),
          tools: [bad],
        }),
      ).toThrow("must be a z.object");
    });

    test("omitting runtime is a construction error", () => {
      expect(() => createAgent({ dataDir: workspace } as AgentConfig)).toThrow();
    });

    test("run() and sessions before start() fail clearly", () => {
      const { agent } = agentWith({});
      expect(() => agent.run("hi")).toThrow("not started");
      expect(() => agent.sessions.list()).toThrow("not started");
    });
  });

  describe("plugin lifecycle", () => {
    test("every plugin context can list and dispatch contributed commands", async () => {
      let gatewayContext: PluginContext | undefined;
      const replies: string[] = [];
      const commands: Plugin = {
        name: "commands",
        commands: [
          {
            name: "status",
            description: "Show status",
            handler: async (ctx) => void ctx.reply(`status:${ctx.args}`),
          },
        ],
      };
      const gateway: Plugin = {
        name: "gateway",
        start(ctx) {
          gatewayContext = ctx;
        },
      };
      const { agent } = agentWith({ plugins: [commands, gateway] });

      await agent.start({ handleSignals: false });

      expect(gatewayContext?.commands.list()).toEqual([
        { name: "status", description: "Show status" },
      ]);
      await expect(
        gatewayContext?.commands.dispatch("status", {
          args: "now",
          reply: async (text) => void replies.push(text),
        }),
      ).resolves.toBe(true);
      await expect(
        gatewayContext?.commands.dispatch("missing", {
          args: "",
          reply: async () => {},
        }),
      ).resolves.toBe(false);
      expect(replies).toEqual(["status:now"]);
    });

    test("plugins start in order with scoped contexts and stop in reverse", async () => {
      const order: string[] = [];
      const make = (name: string): Plugin => ({
        name,
        start: () => {
          order.push(`start:${name}`);
        },
        stop: () => {
          order.push(`stop:${name}`);
        },
      });
      const { agent } = agentWith({ plugins: [make("a"), make("b")] });

      await agent.start({ handleSignals: false });
      await agent.stop();

      expect(order).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
    });

    test("releaseSession failures do not strand other plugins", async () => {
      const released: string[] = [];
      const observer: Plugin = {
        name: "observer",
        releaseSession: ({ source, key }) => void released.push(`${source}/${key}`),
      };
      const bad: Plugin = {
        name: "bad",
        releaseSession: () => {
          throw new Error("nope");
        },
      };
      const { agent } = agentWith({ plugins: [observer, bad] });
      await agent.start({ handleSignals: false });
      await agent.sessions.run("one", "hello");

      await agent.sessions.reset("one");

      expect(released).toEqual(["host/one"]);
    });

    test("a plugin failing to stop does not strand the others", async () => {
      const order: string[] = [];
      const bad: Plugin = {
        name: "bad",
        stop: () => {
          throw new Error("nope");
        },
      };
      const good: Plugin = {
        name: "good",
        stop: () => {
          order.push("stop:good");
        },
      };
      const { agent } = agentWith({ plugins: [good, bad] });
      await agent.start({ handleSignals: false });
      await agent.stop();
      expect(order).toEqual(["stop:good"]);
    });

    test("handleSignals: false installs no signal handlers", async () => {
      const before = process.listenerCount("SIGINT");
      const { agent } = agentWith({});
      await agent.start({ handleSignals: false });
      expect(process.listenerCount("SIGINT")).toBe(before);
      await agent.stop();
    });

    test("ctx.filePath resolves under the plugin's private directory", async () => {
      let dataPath = "";
      const plugin: Plugin = {
        name: "cron",
        start: (ctx: PluginContext) => {
          dataPath = ctx.filePath("output", "run-1.md");
        },
      };
      const { agent } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      expect(dataPath).toBe(path.join(workspace, "agent", "plugins", "cron", "output", "run-1.md"));
    });

    test("ctx.runtime.exec runs through the runtime in a throwaway workspace", async () => {
      let ctx!: PluginContext;
      const plugin: Plugin = {
        name: "cron",
        start: (c) => {
          ctx = c;
        },
      };
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      const output = await ctx.runtime.exec("df -h");

      expect(output).toBe("ran: df -h");
      expect(runtime.execs).toHaveLength(1);
      expect(runtime.execs[0]).toMatchObject({ command: "df -h", timeoutMs: 300_000 });
      // The throwaway cwd lives under {workspace}/agent/sessions/host and is gone afterwards.
      expect(runtime.execs[0]!.cwd).toContain(path.join(workspace, "agent", "sessions", "host"));
      expect(existsSync(runtime.execs[0]!.cwd)).toBe(false);
    });

    test("the old PluginContext members are gone", async () => {
      let ctx!: PluginContext;
      const plugin: Plugin = {
        name: "cron",
        start: (c) => {
          ctx = c;
        },
      };
      const { agent } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      // @ts-expect-error — runPrompt was renamed to run
      expect(ctx.runPrompt).toBeUndefined();
      // @ts-expect-error — runScript moved to runtime.exec
      expect(ctx.runScript).toBeUndefined();
      // @ts-expect-error — dataDir was renamed to filePath
      expect(ctx.dataDir).toBeUndefined();
    });

    test("plugin sessions are namespaced by plugin name", async () => {
      let ctx!: PluginContext;
      const plugin: Plugin = {
        name: "telegram",
        start: (c) => {
          ctx = c;
        },
      };
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      await ctx.sessions.run("42", "hello");

      expect(runtime.spawns[0]!.spec.cwd).toBe(
        path.join(workspace, "agent", "sessions", "telegram", "42"),
      );
    });

    test("a per-session env var reaches the spawn", async () => {
      let ctx!: PluginContext;
      const plugin: Plugin = {
        name: "telegram",
        start: (c) => {
          ctx = c;
        },
      };
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      await ctx.sessions.run("42", "hi", { session: { env: { GH_TOKEN: "tok-abc" } } });

      expect(runtime.spawns[0]!.spec.env.GH_TOKEN).toBe("tok-abc");
    });

    test("sessions is lifecycle-only — it carries no env (static env lives in the host env)", () => {
      const config: AgentConfig = {
        runtime: new FakeRuntime(),
        sessions: {
          idleTimeout: "2h",
          // @ts-expect-error — sessions is lifecycle-only; per-session env is SessionOptions.env
          env: { X: "y" },
        },
      };
      expect(config.sessions?.idleTimeout).toBe("2h");
    });

    test("prepareSession runs only for the owning plugin's sessions", async () => {
      const calls: string[] = [];
      let ctx!: PluginContext;
      const telegram: Plugin = {
        name: "telegram",
        start: (c) => {
          ctx = c;
        },
        prepareSession: ({ ref }) => {
          calls.push(`telegram:${ref.source}/${ref.key}`);
        },
      };
      const other: Plugin = {
        name: "other",
        prepareSession: ({ ref }) => {
          calls.push(`other:${ref.source}/${ref.key}`);
        },
      };
      const { agent } = agentWith({ plugins: [telegram, other] });
      await agent.start({ handleSignals: false });

      await ctx.sessions.run("42", "hello"); // telegram-owned
      await agent.run("hi"); // host-owned

      // Only telegram owns the "42" session; "other" owns neither session, so it never prepares.
      expect(calls).toEqual(["telegram:telegram/42"]);
    });

    test("prepareAllSessions runs after the owning plugin for every session", async () => {
      const calls: string[] = [];
      let ctx!: PluginContext;
      const owner: Plugin = {
        name: "gateway",
        start: (value) => {
          ctx = value;
        },
        prepareSession: ({ ref }) => void calls.push(`owner:${ref.source}/${ref.key}`),
      };
      const global: Plugin = {
        name: "global",
        prepareAllSessions: ({ ref }) => void calls.push(`global:${ref.source}/${ref.key}`),
      };
      const { agent } = agentWith({ plugins: [owner, global] });
      await agent.start({ handleSignals: false });

      await ctx.sessions.run("one", "hello");
      await agent.run("hello");

      expect(calls[0]).toBe("owner:gateway/one");
      expect(calls[1]).toBe("global:gateway/one");
      expect(calls[2]).toMatch(/^global:host\//);
    });

    test("dependencyMounts no longer typechecks — dependency exposure moved to bwrap()", () => {
      const config: AgentConfig = {
        runtime: new FakeRuntime(),
        // @ts-expect-error — bwrap({ autoMountDependencies }) replaced it
        dependencyMounts: false,
      };
      expect(config.runtime).toBeDefined();
    });
  });

  describe("tool bridge wiring", () => {
    /**
     * Bridge credentials as the runtime receives them: url and per-session token, both on the
     * spec's bridge field (the runtime writes them to bridge.json — the token never rides the env
     * or argv).
     */
    function bridgeOf(spawn: FakeSpawn): { url: string; token: string } {
      return {
        url: spawn.spec.bridge.url,
        token: spawn.spec.bridge.token!,
      };
    }

    async function callBridge(
      bridge: { url: string; token: string },
      toolName: string,
      args: unknown,
    ): Promise<Response> {
      return fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: toolName, args }),
      });
    }

    test("sessions get an argv config whose /call endpoint + bridge token serve the agent's tools", async () => {
      const weather = tool({
        name: "get_weather",
        description: "d",
        input: z.object({ city: z.string() }),
        execute: () => "sunny",
      });
      const { agent, runtime } = agentWith({ name: "test-agent", tools: [weather] });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k1", "hi");

      const spawn = runtime.spawns[0]!;
      expect(spawn.spec.bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/call$/);
      expect(spawn.spec.tools!.map((t) => t.name)).toEqual(["get_weather"]);
      // The token is a secret: it rides bridge.token (→ bridge.json), never the (argv-bound) pi config.
      expect(JSON.stringify(spawn.spec.pi)).not.toContain(spawn.spec.bridge.token);

      // The minted token executes tools against the live bridge.
      const res = await callBridge(bridgeOf(spawn), "get_weather", { city: "Sydney" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        content: [{ type: "text", text: "sunny" }],
        isError: false,
      });
    });

    test("no tools → empty tool manifest, no mcp servers", async () => {
      const { agent, runtime } = agentWith({});
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k1", "hi");

      const { spec } = runtime.spawns[0]!;
      // The bridge always runs (session-scoped tools may appear later), but
      // the manifest tells the worker there is nothing to register.
      expect(spec.bridge.url).toMatch(/\/call$/);
      expect(spec.tools).toEqual([]);
      expect(spec.pi.mcpServers).toBeUndefined();
    });

    test("a session tool observes the pinned sender; credentials never ride the context", async () => {
      const seen: { user?: unknown; token?: unknown }[] = [];
      const whoami = tool({
        name: "whoami",
        description: "d",
        input: z.object({}),
        execute: (_, ctx) => {
          // @ts-expect-error — ctx.connections is gone; tokens never reach plugin tools
          expect(ctx.connections).toBeUndefined();
          seen.push({ user: ctx.user, token: ctx.token });
          return "ok";
        },
      });
      const { agent, runtime } = agentWith({ tools: [whoami] });
      await agent.start({ handleSignals: false });

      // The turn pins the sender; the pin is sticky, so a bridge call with
      // this session's token — as the worker makes mid-turn — sees the user.
      await agent.sessions.run("k1", "hi", { user: { source: "telegram", id: "123" } });
      const res = await callBridge(bridgeOf(runtime.spawns[0]!), "whoami", {});

      expect(res.status).toBe(200);
      // ctx.token exists only for connector tools (the adapter's wrapper
      // injects it) — the kernel never sets it on plugin tools.
      expect(seen).toEqual([{ user: { source: "telegram", id: "123" }, token: undefined }]);
    });

    test("one-shot runs bind tools and revoke the token at teardown", async () => {
      const { agent, runtime } = agentWith({ name: "test-agent" });
      await agent.start({ handleSignals: false });

      const reply = tool({
        name: "reply",
        description: "d",
        input: z.object({ text: z.string() }),
        execute: () => "sent",
      });
      await agent.run("hi", { tools: [reply] });

      const res = await callBridge(bridgeOf(runtime.spawns[0]!), "reply", { text: "x" });
      expect(res.status).toBe(401);
    });
  });

  describe("hermetic agent config", () => {
    test("pi settings/models/packages travel on every spawn's resolved pi config", async () => {
      const models = {
        providers: { llama: { baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "q" }] } },
      };
      const { agent, runtime } = agentWith({
        pi: {
          model: "llama/q",
          settings: { quietStartup: true },
          models,
          packages: ["npm:my-extension@1.0.0"],
        },
      });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");
      const pi = runtime.spawns[0]!.spec.pi;
      expect(pi.model).toBe("llama/q");
      expect(pi.settings).toEqual({ quietStartup: true });
      expect(pi.models).toEqual(models);
      // The user's source string and the always-bundled MCP adapter both travel.
      expect(pi.packages).toContain("npm:my-extension@1.0.0");
      expect(pi.packages!.some((p) => p.includes("pi-mcp-adapter"))).toBe(true);
    });

    test("declared skills/prompts dirs travel on the spec", async () => {
      const skills = path.join(workspace, "my-skills");
      const prompts = path.join(workspace, "my-prompts");
      mkdirSync(skills, { recursive: true });
      mkdirSync(prompts, { recursive: true });
      const { agent, runtime } = agentWith({ pi: { skills: [skills], prompts: [prompts] } });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");

      // A mounting runtime (e.g. @picco-agent/runtime-bwrap) reads these off the
      // spec to decide what to bind into the sandbox.
      const pi = runtime.spawns[0]!.spec.pi;
      expect(pi.skills).toEqual([skills]);
      expect(pi.prompts).toEqual([prompts]);
    });

    test("agent-wide and per-session pi.instructions concatenate", async () => {
      const { agent, runtime } = agentWith({ pi: { instructions: "BASE RULES" } });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi", { session: { pi: { instructions: "SESSION RULES" } } });
      expect(runtime.spawns[0]!.spec.pi.instructions).toBe("BASE RULES\n\nSESSION RULES");

      // Without a per-session override, instructions is just the base.
      await agent.sessions.run("k2", "hi");
      expect(runtime.spawns[1]!.spec.pi.instructions).toBe("BASE RULES");
    });

    test("a per-run pi override replaces config.pi fields; the base applies without an override", async () => {
      const { agent, runtime } = agentWith({ pi: { model: "base/model", thinking: "low" } });
      await agent.start({ handleSignals: false });

      await agent.run("with override", { pi: { model: "override/model", thinking: "high" } });
      await agent.run("no override");

      const first = runtime.spawns[0]!.spec.pi;
      expect(first.model).toBe("override/model");
      expect(first.thinking).toBe("high");

      const second = runtime.spawns[1]!.spec.pi;
      expect(second.model).toBe("base/model");
      expect(second.thinking).toBe("low");
    });

    test("a per-session pi override sets path fields (skills, packages), replacing the base", async () => {
      const sessionSkills = path.join(workspace, "session-skills");
      mkdirSync(sessionSkills, { recursive: true });
      const { agent, runtime } = agentWith({ pi: { packages: ["npm:base@1.0.0"] } });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi", {
        session: { pi: { skills: [sessionSkills], packages: ["npm:extra@1.0.0"] } },
      });

      const pi = runtime.spawns[0]!.spec.pi;
      // The override's skills are resolved and carried; packages replace the base
      // (merge contract), while the always-bundled adapter still rides.
      expect(pi.skills).toEqual([sessionSkills]);
      expect(pi.packages).toContain("npm:extra@1.0.0");
      expect(pi.packages).not.toContain("npm:base@1.0.0");
      expect(pi.packages!.some((p) => p.includes("pi-mcp-adapter"))).toBe(true);
    });

    test("a per-session env var reaches the spawn; the bridge token rides bridge.token, not env", async () => {
      const { agent, runtime } = agentWith({});
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi", { session: { env: { GH_TOKEN: "tok-abc" } } });

      const { spec } = runtime.spawns[0]!;
      // The caller's per-session env is the only thing the host puts on spec.env — no kernel
      // secret rides there; the bridge token rides the bridge field (→ bridge.json). Static
      // credentials come from the ambient runtime env (local inherits it; bwrap forwards a list).
      expect(spec.env).toEqual({ GH_TOKEN: "tok-abc" });
      expect(spec.bridge.token).toEqual(expect.any(String));
      expect(JSON.stringify(spec.env)).not.toContain(spec.bridge.token);
    });
  });

  describe("bundled MCP adapter", () => {
    const MCP_ADAPTER_SOURCE = "npm:pi-mcp-adapter@2.11.0";

    /**
     * The session's resolved packages list from a recorded spawn.
     */
    function packagesOf(spawn: FakeSpawn): string[] | undefined {
      return spawn.spec.pi.packages;
    }

    function isAdapter(p: string): boolean {
      return p === MCP_ADAPTER_SOURCE;
    }

    test("sessions with mcpServers get the bundled adapter appended", async () => {
      const { agent, runtime } = agentWith({
        pi: { mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } } },
      });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");

      const packages = packagesOf(runtime.spawns[0]!)!;
      expect(packages.filter(isAdapter)).toHaveLength(1);
      // Delivered as a pi npm source string — pi installs it at session start.
      expect(packages).toContain(MCP_ADAPTER_SOURCE);
    });

    test("the mcp adapter is always bundled", async () => {
      const { agent, runtime } = agentWith({});
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");

      const packages = packagesOf(runtime.spawns[0]!)!;
      expect(packages.filter(isAdapter)).toHaveLength(1);
    });

    test("the bridge extension is injected as a bundled file-path extension", async () => {
      const { agent, runtime } = agentWith({});
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");

      // It rides pi.extensions (a file path), not pi.packages, and points at a
      // real built bundle so a jailing runtime can mount the single file.
      const extensions = runtime.spawns[0]!.spec.pi.extensions ?? [];
      const bridge = extensions.find((p) => p.includes("bridge-extension"));
      expect(bridge).toBeDefined();
      expect(bridge!.endsWith(".js")).toBe(true);
      expect(existsSync(bridge!)).toBe(true);
      // …and it is NOT in packages.
      expect(
        (packagesOf(runtime.spawns[0]!) ?? []).some((p) => p.includes("bridge-extension")),
      ).toBe(false);
    });

    test("a user pi.packages source string rides alongside the bundled adapter", async () => {
      const { agent, runtime } = agentWith({
        pi: {
          packages: ["npm:context-mode@1.0.0"],
          mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } },
        },
      });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi");

      const packages = packagesOf(runtime.spawns[0]!)!;
      expect(packages).toContain("npm:context-mode@1.0.0");
      expect(packages).toContain(MCP_ADAPTER_SOURCE);
    });

    test("a session whose only MCP servers come from a configureSession hook gets the adapter", async () => {
      let ctx!: PluginContext;
      const p: Plugin = {
        name: "telegram",
        start: (c) => {
          ctx = c;
        },
        configureSession: (_session, pi) => ({
          ...pi,
          mcpServers: { ...pi.mcpServers, deepwiki: { url: "https://mcp.deepwiki.com/mcp" } },
        }),
      };
      const { agent, runtime } = agentWith({ plugins: [p] });
      await agent.start({ handleSignals: false });

      await ctx.sessions.run("k", "hi");

      expect(packagesOf(runtime.spawns[0]!)!.filter(isAdapter)).toHaveLength(1);
    });

    test("with a global session plugin, the mcp adapter is always bundled", async () => {
      const global: Plugin = {
        name: "global",
        configureAllSessions: ({ key }, pi) =>
          key === "with"
            ? {
                ...pi,
                mcpServers: {
                  ...pi.mcpServers,
                  linear: { url: "http://127.0.0.1:9999/mcp/linear" },
                },
              }
            : pi,
      };
      const { agent, runtime } = agentWith({ plugins: [global] });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("with", "hi");
      await agent.sessions.run("without", "hi");

      // The MCP adapter is always bundled in every session
      expect(packagesOf(runtime.spawns[0]!)!.filter(isAdapter)).toHaveLength(1);
      expect(packagesOf(runtime.spawns[1]!)!.filter(isAdapter)).toHaveLength(1);
    });
  });

  describe("configureSession fold", () => {
    /**
     * A plugin that captures its context (so a test can run sessions it owns) and contributes
     * session config. configureSession runs only for sessions the plugin owns (ref.source ===
     * name).
     */
    function owner(
      name: string,
      configure: NonNullable<Plugin["configureSession"]>,
    ): { plugin: Plugin; ctx: () => PluginContext } {
      let captured: PluginContext;
      const plugin: Plugin = {
        name,
        start: (c) => {
          captured = c;
        },
        configureSession: configure,
      };
      return { plugin, ctx: () => captured };
    }

    test("the owning plugin's configureSession runs for its session and reaches the spawn spec", async () => {
      const { plugin, ctx } = owner("telegram", (_s, pi) => ({ ...pi, model: "llama/q" }));
      const { agent, runtime } = agentWith({
        pi: { model: "anthropic/claude-sonnet-4-5" },
        plugins: [plugin],
      });
      await agent.start({ handleSignals: false });

      await ctx().sessions.run("42", "hi");

      expect(runtime.spawns[0]!.spec.pi.model).toBe("llama/q");
    });

    test("a plugin does not configure sessions it does not own (host or another plugin's)", async () => {
      const seen: string[] = [];
      const { plugin: telegram, ctx } = owner("telegram", (_s, pi) => pi);
      const other: Plugin = {
        name: "other",
        configureSession: ({ source }, pi) => {
          seen.push(source);
          return pi;
        },
      };
      const { agent } = agentWith({ plugins: [telegram, other] });
      await agent.start({ handleSignals: false });

      await agent.sessions.run("k", "hi"); // host-owned
      await ctx().sessions.run("42", "hi"); // telegram-owned

      // "other" owns neither session, so its configureSession never runs.
      expect(seen).toEqual([]);
    });

    test("configureAllSessions folds after the owning plugin", async () => {
      const calls: string[] = [];
      const { plugin, ctx } = owner("telegram", (_s, pi) => {
        calls.push("plugin");
        return {
          ...pi,
          mcpServers: { ...pi.mcpServers, mine: { url: "http://127.0.0.1:1/mcp" } },
        };
      });
      const global: Plugin = {
        name: "global",
        configureAllSessions: (_s, pi) => {
          calls.push("global");
          expect(pi.mcpServers).toHaveProperty("mine");
          return {
            ...pi,
            mcpServers: {
              ...pi.mcpServers,
              linear: { url: "http://127.0.0.1:9999/mcp/linear" },
            },
          };
        },
      };
      const { agent, runtime } = agentWith({ plugins: [plugin, global] });
      await agent.start({ handleSignals: false });

      await ctx().sessions.run("42", "hi");

      expect(calls).toEqual(["plugin", "global"]);
      expect(runtime.spawns[0]!.spec.pi.mcpServers).toEqual({
        mine: { url: "http://127.0.0.1:1/mcp" },
        linear: { url: "http://127.0.0.1:9999/mcp/linear" },
      });
    });

    test("configureAllSessions also configures host sessions", async () => {
      const global: Plugin = {
        name: "global",
        configureAllSessions: (_s, pi) => ({
          ...pi,
          mcpServers: { linear: { url: "http://127.0.0.1:9999/mcp/linear" } },
        }),
      };
      const { agent, runtime } = agentWith({ plugins: [global] });
      await agent.start({ handleSignals: false });

      await agent.run("hi");

      expect(runtime.spawns[0]!.spec.pi.mcpServers).toEqual({
        linear: { url: "http://127.0.0.1:9999/mcp/linear" },
      });
    });

    test("the owning plugin can override a static pi.mcpServers entry", async () => {
      const { plugin, ctx } = owner("telegram", (_s, pi) => ({
        ...pi,
        mcpServers: { ...pi.mcpServers, deepwiki: { url: "http://plugin/mcp" } },
      }));
      const { agent, runtime } = agentWith({
        pi: { mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } } },
        plugins: [plugin],
      });
      await agent.start({ handleSignals: false });

      await ctx().sessions.run("42", "hi");
      // The plugin's value overrides the static config
      expect(runtime.spawns[0]!.spec.pi.mcpServers).toEqual({
        deepwiki: { url: "http://plugin/mcp" },
      });
    });

    test("a global hook can override the owning plugin's MCP name", async () => {
      const { plugin, ctx } = owner("telegram", (_s, pi) => ({
        ...pi,
        mcpServers: { ...pi.mcpServers, linear: { url: "http://127.0.0.1:1" } },
      }));
      const global: Plugin = {
        name: "global",
        configureAllSessions: (_s, pi) => ({
          ...pi,
          mcpServers: { ...pi.mcpServers, linear: { url: "http://127.0.0.1:9999/mcp/linear" } },
        }),
      };
      const { agent, runtime } = agentWith({ plugins: [plugin, global] });
      await agent.start({ handleSignals: false });

      await ctx().sessions.run("42", "hi");
      expect(runtime.spawns[0]!.spec.pi.mcpServers).toEqual({
        linear: { url: "http://127.0.0.1:9999/mcp/linear" },
      });
    });

    test("a hook can write to pi.settings", async () => {
      const { plugin, ctx } = owner("telegram", (_s, pi) => ({
        ...pi,
        settings: { ...pi.settings, custom: true },
      }));
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      await ctx().sessions.run("42", "hi");
      expect(runtime.spawns[0]!.spec.pi.settings).toEqual({ custom: true });
    });

    test("a throwing hook fails the spawn and rejects the triggering turn", async () => {
      const { plugin, ctx } = owner("telegram", () => {
        throw new Error("bad day");
      });
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      await expect(ctx().sessions.run("42", "hi")).rejects.toThrow("bad day");
      expect(runtime.spawns).toHaveLength(0);
    });

    test("one-shots run the owning plugin's prepareSession and configureSession", async () => {
      const calls: string[] = [];
      let ctx!: PluginContext;
      const cron: Plugin = {
        name: "cron",
        start: (c) => {
          ctx = c;
        },
        prepareSession: ({ ref }) => {
          calls.push(`prepare:${ref.source}/${ref.key}`);
        },
        configureSession: ({ source, key }, pi) => {
          calls.push(`configure:${source}/${key}`);
          return { ...pi, settings: { ...pi.settings, seeded: true } };
        },
      };
      const { agent, runtime } = agentWith({ plugins: [cron] });
      await agent.start({ handleSignals: false });

      await ctx.run("go");

      // Files (prepare) before config, on the same cron-owned one-shot session —
      // source is the calling plugin, key the run's generated timestamp+suffix.
      expect(calls).toEqual([
        expect.stringMatching(/^prepare:cron\/\d{4}-\d{2}-\d{2}T/),
        expect.stringMatching(/^configure:cron\/\d{4}-\d{2}-\d{2}T/),
      ]);
      expect(calls[0]!.slice("prepare:".length)).toBe(calls[1]!.slice("configure:".length));
      expect(runtime.spawns[0]!.spec.pi.settings).toEqual({ seeded: true });
    });

    test("a hook throw rejects the one-shot turn", async () => {
      const { plugin, ctx } = owner("cron", () => {
        throw new Error("no session for you");
      });
      const { agent, runtime } = agentWith({ plugins: [plugin] });
      await agent.start({ handleSignals: false });

      await expect(ctx().run("go")).rejects.toThrow("no session for you");
      expect(runtime.spawns).toHaveLength(0);
    });
  });

  describe("one-shot runs", () => {
    test("agent.run works after start and tears the session down", async () => {
      const { agent, runtime } = agentWith({});
      await agent.start({ handleSignals: false });

      const { text } = await agent.run("Say OK if you can hear me.");

      expect(text).toBe("echo: Say OK if you can hear me.");
      expect(runtime.spawns[0]!.spec.cwd).toContain(
        path.join(workspace, "agent", "sessions", "host"),
      );
      expect(runtime.spawns[0]!.process.killed).toBe(true);
    });
  });
});
