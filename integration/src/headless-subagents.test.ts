import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import { createServer as createMonitor } from "node:net";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, RpcClient, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgent, tool } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { startFakeMcp } from "./fake-mcp.js";
import { lastToolText, startFakeModel, type ChatRequest, type ModelAction } from "./fake-model.js";

const piCliPath =
  process.env.PICCO_TEST_PI_CLI ??
  path.join(
    path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "cli.js",
  );
const packageDirectory = path.resolve(import.meta.dirname, "../../packages/headless-subagents");
const EntrySchema = z.object({
  type: z.literal("entry_appended"),
  entry: z.object({
    type: z.literal("custom"),
    customType: z.literal("headless-subagents:event"),
    data: z.object({
      version: z.literal(1),
      rootSessionId: z.string(),
      agentId: z.string(),
      parentAgentId: z.string().nullable(),
      event: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  }),
});
const RecordSchema = z.object({
  id: z.string(),
  parentAgentId: z.string().nullable(),
  status: z.string(),
  depth: z.number(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  transcriptPath: z.string().nullable(),
});
const TreeSchema = z.object({ manifestPath: z.string(), agents: z.array(RecordSchema).max(10) });
const SpawnResultSchema = z.object({ agent: z.object({ id: z.string() }) });
const cleanups: (() => Promise<void> | void)[] = [];
let bundle: string | undefined;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Build the same independently loadable bundle that the npm package publishes.
 */
function extensionBundle(): string {
  if (bundle) return bundle;
  const output = path.join(packageDirectory, "dist", "index.js");
  const newestSource = Math.max(
    ...readdirSync(path.join(packageDirectory, "src"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => statSync(path.join(packageDirectory, "src", name)).mtimeMs),
  );
  if (!existsSync(output) || statSync(output).mtimeMs < newestSource) {
    execFileSync("pnpm", ["build"], { cwd: packageDirectory, stdio: "pipe" });
  }
  bundle = output;
  return output;
}

/**
 * A task script delegates twice, joins both children, then returns the inspectable tree.
 */
function delegationScript(request: ChatRequest): ModelAction[] {
  const task = JSON.stringify(
    request.messages.filter((message) => message.role === "user").at(-1)?.content,
  );
  const previous = lastToolText(request);
  if (task.includes("GRANDCHILD_JOB")) return [{ text: "grandchild complete" }];
  if (task.includes("CHILD_JOB")) {
    if (!previous)
      return [{ toolCall: { name: "spawn_agent", args: { prompt: "GRANDCHILD_JOB" } } }];
    const parsed = SpawnResultSchema.safeParse(parseJson(previous));
    if (parsed.success && !previous.includes('"outputAvailable"')) {
      return [
        {
          toolCall: {
            name: "get_agent_result",
            args: { agentId: parsed.data.agent.id, wait: true },
          },
        },
      ];
    }
    return [{ text: "child complete" }];
  }
  if (!previous)
    return [
      {
        toolCall: {
          name: "spawn_agent",
          args: { prompt: "CHILD_JOB", model: "dynamic/second", thinking: "high" },
        },
      },
    ];
  const parsed = SpawnResultSchema.safeParse(parseJson(previous));
  if (parsed.success && !previous.includes('"outputAvailable"')) {
    return [
      {
        toolCall: { name: "get_agent_result", args: { agentId: parsed.data.agent.id, wait: true } },
      },
    ];
  }
  if (!previous.includes('"agents"')) return [{ toolCall: { name: "list_agents", args: {} } }];
  return [{ text: previous }];
}

/**
 * Invalid JSON is ordinary tool text, not a structured spawn result.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Isolated fixture configuration uses only a local fake provider and project-owned files.
 */
async function fixture(script = delegationScript) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "headless-int-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const server = await startFakeModel(script);
  cleanups.push(() => server.close());
  const agentDirectory = path.join(directory, ".pi", "agent");
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
  const providerExtension = path.join(directory, "dynamic-provider.mjs");
  const provider = {
    baseUrl: server.url,
    api: "openai-completions",
    apiKey: "fixture-provider-key",
    models: [
      {
        id: "second",
        name: "Second",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  };
  writeFileSync(
    providerExtension,
    `export default function(pi) { pi.registerProvider("dynamic", ${JSON.stringify(provider)}); }\n`,
  );
  const models = {
    providers: {
      fake: {
        baseUrl: server.url,
        api: "openai-completions",
        apiKey: "fixture-main-key",
        models: [{ id: "fake-1", reasoning: true }],
      },
    },
  };
  const settings = {
    defaultProvider: "fake",
    defaultModel: "fake-1",
    defaultThinkingLevel: "low" as const,
    extensions: [extensionBundle(), providerExtension],
    retry: { enabled: false },
  };
  writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify(models));
  writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify(settings));
  const traces = path.join(directory, "traces");
  writeFileSync(
    path.join(agentDirectory, "headless-subagents.json"),
    JSON.stringify({ outputDirectory: traces, timeoutMs: 15000 }),
  );
  return { directory, agentDirectory, providerExtension, models, settings, traces, server };
}

/**
 * Native transcripts and manifests stay readable after the root worker has exited.
 */
function verifyTree(tree: z.infer<typeof TreeSchema>) {
  expect(tree.agents).toHaveLength(2);
  const child = tree.agents.find((agent) => agent.depth === 1)!;
  const grandchild = tree.agents.find((agent) => agent.depth === 2)!;
  expect(child.parentAgentId).toBeNull();
  expect(grandchild.parentAgentId).toBe(child.id);
  for (const agent of tree.agents) {
    expect(agent.status).toBe("completed");
    expect(agent.model).toBe("dynamic/second");
    expect(agent.thinking).toBe("high");
    expect(statSync(agent.transcriptPath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(agent.transcriptPath!, "utf8")).toContain("headless-subagents:identity");
  }
  const manifest = readFileSync(tree.manifestPath, "utf8");
  expect(manifest).toContain(child.id);
  expect(manifest).toContain(grandchild.id);
  const rootTranscriptPath = z
    .object({ rootTranscriptPath: z.string() })
    .parse(JSON.parse(manifest)).rootTranscriptPath;
  expect(readFileSync(rootTranscriptPath, "utf8")).toContain("headless-subagents:execution");
  expect(readFileSync(rootTranscriptPath, "utf8")).toContain(tree.manifestPath);
}

describe("headless subagents with real Pi workers", () => {
  test("stock Pi RPC preserves nested model/thinking inheritance and all-depth files", async () => {
    const f = await fixture();
    const skillDirectory = path.join(f.directory, "explicit-skill");
    mkdirSync(skillDirectory);
    writeFileSync(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: explicit-skill\ndescription: Explicit CLI skill fixture\n---\nExplicit skill instruction\n",
    );
    const explicitExtension = path.join(f.directory, "explicit-extension.mjs");
    writeFileSync(
      explicitExtension,
      `export default function(pi) { pi.registerTool({name:"explicit_echo",label:"Echo",description:"Explicit CLI echo",parameters:{type:"object",properties:{},additionalProperties:false},async execute(){return {content:[{type:"text",text:"explicit-tool-result"}],details:{}}}}); }`,
    );
    f.server.setScript((request) => {
      const task = JSON.stringify(
        request.messages.filter((message) => message.role === "user").at(-1)?.content,
      );
      if (task.includes("GRANDCHILD_JOB") && !lastToolText(request))
        return [{ toolCall: { name: "explicit_echo", args: {} } }];
      return delegationScript(request);
    });
    const client = new RpcClient({
      cliPath: piCliPath,
      cwd: f.directory,
      env: { PI_CODING_AGENT_DIR: f.agentDirectory },
      args: [
        "--approve",
        "--session-dir",
        f.directory,
        "--skill",
        skillDirectory,
        "-e",
        explicitExtension,
      ],
    });
    cleanups.push(() => client.stop());
    const observations: z.infer<typeof EntrySchema>[] = [];
    client.onEvent((event) => {
      const parsed = EntrySchema.safeParse(event);
      if (parsed.success) observations.push(parsed.data);
    });
    await client.start();
    const idle = client.waitForIdle(30000);
    await client.prompt("ROOT_JOB private root conversation");
    await idle;
    const tree = TreeSchema.parse(parseJson((await client.getLastAssistantText()) ?? ""));
    await client.stop();
    verifyTree(tree);
    expect(new Set(observations.map((entry) => entry.entry.data.agentId)).size).toBe(2);
    expect(observations.some((entry) => entry.entry.data.parentAgentId !== null)).toBe(true);
    expect(
      f.server.requests.some((request) => request.authorization === "Bearer fixture-provider-key"),
    ).toBe(true);
    const childRequests = f.server.requests.filter((request) =>
      JSON.stringify(
        request.params.messages.filter((message) => message.role === "user").at(-1)?.content,
      ).includes("CHILD_JOB"),
    );
    expect(childRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(childRequests)).not.toContain("private root conversation");
    expect(JSON.stringify(childRequests[0]!.params.messages[0])).toContain("explicit-skill");
    const grandchild = tree.agents.find((record) => record.depth === 2)!;
    expect(readFileSync(grandchild.transcriptPath!, "utf8")).toContain("explicit-tool-result");
  }, 60000);

  test("stock Pi RPC children inherit settings changed after session startup", async () => {
    const f = await fixture((request) => {
      const task = JSON.stringify(
        request.messages.filter((message) => message.role === "user").at(-1)?.content,
      );
      const previous = lastToolText(request);
      if (task.includes("SETTINGS_CHILD")) {
        return previous
          ? [{ text: previous }]
          : [{ toolCall: { name: "read_compaction", args: {} } }];
      }
      if (!previous)
        return [{ toolCall: { name: "spawn_agent", args: { prompt: "SETTINGS_CHILD" } } }];
      const spawned = SpawnResultSchema.safeParse(parseJson(previous));
      if (spawned.success && !previous.includes('"outputAvailable"'))
        return [
          {
            toolCall: {
              name: "get_agent_result",
              args: { agentId: spawned.data.agent.id, wait: true },
            },
          },
        ];
      return [{ text: previous }];
    });
    const extension = path.join(f.directory, "read-settings.mjs");
    writeFileSync(
      extension,
      `export default function(pi) { pi.registerTool({name:"read_compaction",label:"Read settings",description:"Read effective compaction settings",parameters:{type:"object",properties:{},additionalProperties:false},async execute(){return {content:[{type:"text",text:JSON.stringify({compactionEnabled:pi.getSettings().compaction?.enabled ?? true})}],details:{}}}}); }`,
    );
    const client = new RpcClient({
      cliPath: piCliPath,
      cwd: f.directory,
      env: { PI_CODING_AGENT_DIR: f.agentDirectory },
      args: ["--approve", "--session-dir", f.directory, "-e", extension],
    });
    cleanups.push(() => client.stop());
    await client.start();
    await client.setAutoCompaction(false);
    const idle = client.waitForIdle(15000);
    await client.prompt("SETTINGS_ROOT");
    await idle;
    const result = z
      .object({
        agent: z.object({ status: z.literal("completed") }),
        output: z.string(),
      })
      .parse(parseJson((await client.getLastAssistantText()) ?? ""));
    expect(JSON.parse(result.output)).toEqual({ compactionEnabled: false });
  }, 30000);

  test("Picco children invoke native MCP and the host bridge with CLI skills", async () => {
    const f = await fixture((request) => {
      const task = JSON.stringify(
        request.messages.filter((message) => message.role === "user").at(-1)?.content,
      );
      const previous = lastToolText(request);
      if (task.includes("RESOURCE_CHILD")) {
        if (!previous)
          return [{ toolCall: { name: "tool_search", args: { query: "probe echo" } } }];
        if (
          !request.messages.some(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message.tool_calls).includes("codemode"),
          )
        )
          return [
            {
              toolCall: {
                name: "codemode",
                args: {
                  code: 'text(await tools.mcp__probe__echo({text:"child-mcp"})); text(await tools.host_echo({text:"child-bridge"}));',
                },
              },
            },
          ];
        return [{ text: previous }];
      }
      if (!previous)
        return [{ toolCall: { name: "spawn_agent", args: { prompt: "RESOURCE_CHILD" } } }];
      const spawned = SpawnResultSchema.safeParse(parseJson(previous));
      if (spawned.success && !previous.includes('"outputAvailable"'))
        return [
          {
            toolCall: {
              name: "get_agent_result",
              args: { agentId: spawned.data.agent.id, wait: true },
            },
          },
        ];
      return [{ text: previous }];
    });
    writeFileSync(
      f.providerExtension,
      readFileSync(f.providerExtension, "utf8").replace(
        "export default function(pi) {",
        'export default function(pi) { pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(),"codemode","tool_search"]));',
      ),
    );
    const mcp = await startFakeMcp();
    cleanups.push(() => mcp.close());
    const skillDirectory = path.join(f.directory, "cli-resource");
    mkdirSync(skillDirectory);
    writeFileSync(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: cli-resource\ndescription: Fixture operating skill\n---\nCLI_SKILL_INSTRUCTION\n",
    );
    const called: string[] = [];
    const agent = createAgent({
      name: "resources",
      dataDir: f.directory,
      runtime: local(),
      pi: {
        model: "fake/fake-1",
        settings: f.settings,
        models: f.models,
        extensions: [extensionBundle(), f.providerExtension],
        skills: [skillDirectory],
        mcpServers: { probe: { url: mcp.url, exposure: "direct" } },
      },
      plugins: [
        {
          name: "resources",
          prepareAllSessions({ cwd }) {
            mkdirSync(path.join(cwd, ".pi"), { recursive: true });
            writeFileSync(
              path.join(cwd, ".pi", "headless-subagents.json"),
              JSON.stringify({ outputDirectory: f.traces, timeoutMs: 15000 }),
            );
          },
          tools: [
            tool({
              name: "host_echo",
              description: "Echo on host",
              input: z.object({ text: z.string() }),
              execute(input) {
                called.push(input.text);
                return `Host echo: ${input.text}`;
              },
            }),
          ],
        },
      ],
    });
    cleanups.push(() => agent.stop());
    await agent.start({ handleSignals: false });
    const result = await agent.sessions.run("resources", "RESOURCE_ROOT", { timeoutMs: 10000 });
    const parsed = z
      .object({
        agent: z.object({ status: z.string(), transcriptPath: z.string() }),
        output: z.string(),
      })
      .parse(parseJson(result.text));
    expect(parsed.output).toContain("MCP echo: child-mcp");
    expect(parsed.agent.status).toBe("completed");
    expect(parsed.agent.transcriptPath.startsWith(`${f.traces}${path.sep}`)).toBe(true);
    expect(parsed.output).toContain("Host echo: child-bridge");
    expect(called).toEqual(["child-bridge"]);
    expect(mcp.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    const childRequests = f.server.requests.filter((request) =>
      JSON.stringify(
        request.params.messages.filter((message) => message.role === "user").at(-1)?.content,
      ).includes("RESOURCE_CHILD"),
    );
    expect(childRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(childRequests[0]!.params.messages[0])).toContain("cli-resource");
  }, 30000);

  test("root turn completion keeps children running until session shutdown", async () => {
    let childStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const f = await fixture((request) => {
      const task = JSON.stringify(
        request.messages.filter((message) => message.role === "user").at(-1)?.content,
      );
      if (task.includes("HANG_CHILD")) {
        childStarted?.();
        return [{ hang: true }];
      }
      const previous = lastToolText(request);
      if (!previous) return [{ toolCall: { name: "spawn_agent", args: { prompt: "HANG_CHILD" } } }];
      if (!previous.includes('"agents"')) return [{ toolCall: { name: "list_agents", args: {} } }];
      return [{ text: previous }];
    });
    const agent = createAgent({
      name: "shutdown",
      dataDir: f.directory,
      runtime: local(),
      pi: {
        model: "fake/fake-1",
        models: f.models,
        settings: f.settings,
        extensions: [extensionBundle()],
      },
    });
    cleanups.push(() => agent.stop());
    await agent.start({ handleSignals: false });
    const response = await agent.sessions.run("shutdown", "SHUTDOWN_ROOT", { timeoutMs: 10000 });
    const tree = TreeSchema.parse(parseJson(response.text));
    expect(tree.agents).toHaveLength(1);
    expect(["starting", "running"]).toContain(tree.agents[0]!.status);
    await started;
    await agent.stop();
    const manifest = z
      .object({
        agents: z.array(z.object({ status: z.string(), transcriptPath: z.string() })).max(10),
      })
      .parse(JSON.parse(readFileSync(tree.manifestPath, "utf8")));
    expect(manifest.agents[0]!.status).toBe("cancelled");
    expect(readFileSync(manifest.agents[0]!.transcriptPath, "utf8")).toContain("HANG_CHILD");
  }, 30000);

  test.each([401, 503, "preflight"] as const)(
    "SDK %s failures produce failed children with classified outcomes",
    async (statusCode) => {
      let childHttpRequests = 0;
      const failing = createServer((request, response) => {
        childHttpRequests++;
        request.resume();
        response
          .writeHead(typeof statusCode === "number" ? statusCode : 503, {
            "content-type": "application/json",
          })
          .end(
            JSON.stringify({
              error: { message: "fixture provider unavailable", type: "server_error" },
            }),
          );
      });
      await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            failing.closeAllConnections();
            failing.close(() => resolve());
          }),
      );
      const address = failing.address();
      if (!address || typeof address === "string") throw new Error("No failing provider address");
      const f = await fixture((request) => {
        const previous = lastToolText(request);
        if (!previous)
          return [
            {
              toolCall: {
                name: "spawn_agent",
                args: { prompt: "FAIL_CHILD", model: "dynamic/second" },
              },
            },
          ];
        const spawned = SpawnResultSchema.safeParse(parseJson(previous));
        if (spawned.success && !previous.includes('"outputAvailable"'))
          return [
            {
              toolCall: {
                name: "get_agent_result",
                args: { agentId: spawned.data.agent.id, wait: true },
              },
            },
          ];
        return [{ text: previous }];
      });
      const provider = readFileSync(f.providerExtension, "utf8").replace(
        f.server.url,
        `http://127.0.0.1:${address.port}/v1`,
      );
      writeFileSync(f.providerExtension, provider);
      if (statusCode === "preflight") {
        writeFileSync(
          f.providerExtension,
          provider.replace(
            /}\s*$/,
            `
          pi.on("session_start", (_event, ctx) => {
            const provider = ctx.modelRegistry.getProvider("dynamic");
            pi.registerProvider({ ...provider, auth: { apiKey: {
              check: async () => ({ type: "api_key" }),
              resolve: async () => { throw new Error('Authentication failed for "dynamic". Credentials may have expired or network is unavailable. Run /login.'); }
            } } });
          });
        }`,
          ),
        );
      }

      const client = new RpcClient({
        cliPath: piCliPath,
        cwd: f.directory,
        env: { PI_CODING_AGENT_DIR: f.agentDirectory },
        args: ["--approve", "--session-dir", f.directory],
      });
      cleanups.push(() => client.stop());
      await client.start();
      const idle = client.waitForIdle(20000);
      await client.prompt("FAIL_ROOT");
      await idle;
      const result = z
        .object({
          agent: z.object({
            status: z.literal("failed"),
            failure: z
              .object({
                category: z.string(),
                statusCode: z.number().optional(),
                reason: z.string().optional(),
              })
              .optional(),
            transcriptPath: z.string(),
          }),
          error: z.string().optional(),
          output: z.string().optional(),
          outputAvailable: z.boolean(),
        })
        .parse(parseJson((await client.getLastAssistantText()) ?? ""));
      if (statusCode === "preflight") {
        expect(result.error).toContain("may have expired");
        expect(result.agent.failure).toMatchObject({
          category: "authentication",
          reason: "credentials_unavailable",
        });
        expect(result.agent.failure?.statusCode).toBeUndefined();
      } else {
        expect(result.agent.failure).toMatchObject({
          category: statusCode === 401 ? "authentication" : "provider_unavailable",
          statusCode,
        });
        if (statusCode === 401)
          expect(result.agent.failure?.reason).toBe("authentication_rejected");
        expect(result.error).toContain(String(statusCode));
      }
      expect(result.output ?? "").toBe("");
      const transcript = readFileSync(result.agent.transcriptPath, "utf8");
      if (statusCode === "preflight") {
        expect(transcript).toContain("may have expired");
        expect(childHttpRequests).toBe(0);
      } else {
        expect(transcript).toContain('"stopReason":"error"');
        expect(transcript).toContain("fixture provider unavailable");
      }
    },
    30000,
  );

  test("SDK shutdown hook errors preserve the completed task and report cleanup failure", async () => {
    const f = await fixture((request) => {
      const task = JSON.stringify(
        request.messages.filter((message) => message.role === "user").at(-1)?.content,
      );
      if (task.includes("CLEANUP_CHILD")) return [{ text: "child answer" }];
      const previous = lastToolText(request);
      if (!previous)
        return [{ toolCall: { name: "spawn_agent", args: { prompt: "CLEANUP_CHILD" } } }];
      const spawned = SpawnResultSchema.safeParse(parseJson(previous));
      if (spawned.success && !previous.includes('"outputAvailable"'))
        return [
          {
            toolCall: {
              name: "get_agent_result",
              args: { agentId: spawned.data.agent.id, wait: true },
            },
          },
        ];
      return [{ text: previous }];
    });
    writeFileSync(
      f.providerExtension,
      readFileSync(f.providerExtension, "utf8").replace(
        /}\s*$/,
        `
      pi.on("session_shutdown", (_event, ctx) => {
        if (ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "headless-subagents:identity")) {
          throw new Error("fixture child shutdown hook failed");
        }
      });
    }`,
      ),
    );
    const client = new RpcClient({
      cliPath: piCliPath,
      cwd: f.directory,
      env: { PI_CODING_AGENT_DIR: f.agentDirectory },
      args: ["--approve", "--session-dir", f.directory],
    });
    cleanups.push(() => client.stop());
    const events: unknown[] = [];
    client.onEvent((event) => {
      events.push(event);
    });
    await client.start();
    const idle = client.waitForIdle(10000);
    await client.prompt("CLEANUP_ROOT");
    await idle;
    const result = z
      .object({
        agent: z.object({
          status: z.literal("completed"),
          cleanupFailure: z.object({ category: z.literal("cleanup"), phase: z.literal("cleanup") }),
          transcriptPath: z.string(),
        }),
        output: z.literal("child answer"),
      })
      .parse(parseJson((await client.getLastAssistantText()) ?? ""));
    expect(readFileSync(result.agent.transcriptPath, "utf8")).toContain(
      "fixture child shutdown hook failed",
    );
    const observations = events.flatMap((event) => {
      const parsed = EntrySchema.safeParse(event);
      return parsed.success ? [parsed.data.entry.data] : [];
    });
    expect(observations.find((event) => event.event === "cleanup.failed")).toMatchObject({
      data: {
        category: "cleanup",
        phase: "cleanup",
        hook: "session_shutdown",
        path: f.providerExtension,
      },
    });
    expect(JSON.stringify(observations)).not.toContain("fixture child shutdown hook failed");
    const manifestPath = path.resolve(
      path.dirname(result.agent.transcriptPath),
      "..",
      "..",
      "manifest.json",
    );
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).agents[0].cleanupFailure).toEqual({
      category: "cleanup",
      phase: "cleanup",
    });
  }, 30000);

  test("SDK hosts receive an explicit failure for unrecreatable inline custom tools", async () => {
    const f = await fixture((request) => {
      const previous = lastToolText(request);
      if (!previous)
        return [{ toolCall: { name: "spawn_agent", args: { prompt: "INLINE_CHILD" } } }];
      const spawned = SpawnResultSchema.safeParse(parseJson(previous));
      if (spawned.success && !previous.includes('"outputAvailable"'))
        return [
          {
            toolCall: {
              name: "get_agent_result",
              args: { agentId: spawned.data.agent.id, wait: true },
            },
          },
        ];
      return [{ text: previous }];
    });
    vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDirectory);
    cleanups.push(() => {
      vi.unstubAllEnvs();
    });
    const created = await createAgentSession({
      cwd: f.directory,
      agentDir: f.agentDirectory,
      settingsManager: SettingsManager.inMemory(f.settings, { projectTrusted: true }),
      customTools: [
        {
          name: "inline_echo",
          label: "Inline",
          description: "Inline SDK callback",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text", text: "inline" }], details: {} };
          },
        },
      ],
    });
    cleanups.push(async () => {
      await created.session.abort();
      await created.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      created.session.dispose();
    });
    await created.session.bindExtensions({});
    await created.session.prompt("INLINE_ROOT");
    const last = created.session.messages.filter((message) => message.role === "assistant").at(-1);
    if (!last || last.role !== "assistant") throw new Error("No root response");
    const result = z
      .object({
        error: z.string(),
        agent: z.object({
          status: z.literal("failed"),
          failure: z
            .object({
              category: z.string(),
              statusCode: z.number().optional(),
              reason: z.string().optional(),
            })
            .optional(),
          transcriptPath: z.string(),
        }),
      })
      .parse(
        parseJson(
          last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ),
      );
    expect(result.error).toContain("inline_echo");
    expect(result.error).toContain("configured file extension");
    const failedTranscript = readFileSync(result.agent.transcriptPath, "utf8");
    expect(failedTranscript).toContain("headless-subagents:identity");
    expect(failedTranscript).toContain("headless-subagents:failure");
    expect(failedTranscript).toContain("inline_echo");
    expect(f.server.requests).toHaveLength(3);
  }, 30000);
  test("stock RPC forwards child completion after the root prompt is idle", async () => {
    const responseReady = Promise.withResolvers<import("node:http").ServerResponse>();
    const provider = createServer((request, response) => {
      request.resume();
      responseReady.resolve(response);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          provider.closeAllConnections();
          provider.close(() => resolve());
        }),
    );
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("No controlled provider address");
    const f = await fixture((request) => {
      const previous = lastToolText(request);
      if (!previous)
        return [
          {
            toolCall: {
              name: "spawn_agent",
              args: { prompt: "BACKGROUND_CHILD", model: "dynamic/second" },
            },
          },
        ];
      return [{ text: previous }];
    });
    writeFileSync(
      f.providerExtension,
      readFileSync(f.providerExtension, "utf8").replace(
        f.server.url,
        `http://127.0.0.1:${address.port}/v1`,
      ),
    );
    const client = new RpcClient({
      cliPath: piCliPath,
      cwd: f.directory,
      env: { PI_CODING_AGENT_DIR: f.agentDirectory },
      args: ["--approve", "--session-dir", f.directory],
    });
    cleanups.push(() => client.stop());
    const completed = Promise.withResolvers<z.infer<typeof EntrySchema>>();
    client.onEvent((event) => {
      const parsed = EntrySchema.safeParse(event);
      if (parsed.success && parsed.data.entry.data.event === "agent.completed")
        completed.resolve(parsed.data);
    });
    await client.start();
    const idle = client.waitForIdle(10000);
    await client.prompt("BACKGROUND_ROOT");
    await idle;
    const child = SpawnResultSchema.parse(
      parseJson((await client.getLastAssistantText()) ?? ""),
    ).agent;
    const response = await responseReady.promise;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "background", object: "chat.completion.chunk", created: 1, model: "second" };
    response.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "background done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    const observation = await completed.promise;
    expect(observation.entry.data.agentId).toBe(child.id);
    expect(f.server.requests).toHaveLength(2);
    expect(await client.getLastAssistantText()).toContain(child.id);
  }, 30000);
  test.each(["stop", "shutdown", "uncooperative tool"])(
    "reaps child-owned stdio MCP processes on %s",
    async (mode) => {
      const processes: { pid: number; closed: Promise<void> }[] = [];
      const monitor = createMonitor((socket) => {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        createInterface({ input: socket }).once("line", (line) => {
          const { pid } = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(line));
          processes.push({ pid, closed });
        });
      });
      await new Promise<void>((resolve) => monitor.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>((resolve) => monitor.close(() => resolve())));
      const address = monitor.address();
      if (!address || typeof address === "string") throw new Error("No MCP monitor address");
      let childStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        childStarted = resolve;
      });
      let childId = "";
      const f = await fixture((request) => {
        const task = JSON.stringify(
          request.messages.filter((message) => message.role === "user").at(-1)?.content,
        );
        const previous = lastToolText(request);
        if (task.includes("MCP_HANG_CHILD")) {
          childStarted?.();
          return mode === "uncooperative tool"
            ? [{ toolCall: { name: "ignore_cancellation", args: {} } }]
            : [{ hang: true }];
        }
        if (task.includes("STOP_MCP_ROOT") && !previous.includes('"status":"cancelled"'))
          return [{ toolCall: { name: "stop_agent", args: { agentId: childId } } }];
        if (!previous)
          return [{ toolCall: { name: "spawn_agent", args: { prompt: "MCP_HANG_CHILD" } } }];
        return [{ text: previous }];
      });
      writeFileSync(
        path.join(f.agentDirectory, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            monitor: {
              command: process.execPath,
              args: [path.join(import.meta.dirname, "fixtures/headless-stdio-mcp.mjs")],
              env: { HEADLESS_MCP_MONITOR_PORT: String(address.port) },
              exposure: "direct",
            },
          },
        }),
      );
      const toolStarted = path.join(f.directory, "tool-started");
      const releaseTool = path.join(f.directory, "release-tool");
      const extension = path.join(f.directory, "ignore-cancellation.mjs");
      writeFileSync(
        extension,
        `import {existsSync,writeFileSync} from "node:fs";
export default function(pi) { pi.registerTool({name:"ignore_cancellation",label:"Ignore cancellation",description:"A non-cooperative file tool",parameters:{type:"object",properties:{},additionalProperties:false},async execute(){writeFileSync(${JSON.stringify(toolStarted)}, "started"); return new Promise(resolve => {const timer = setInterval(() => {if(existsSync(${JSON.stringify(releaseTool)})){clearInterval(timer);resolve({content:[{type:"text",text:"released"}],details:{}});}}, 20);});}}); }`,
      );
      const client = new RpcClient({
        cliPath: piCliPath,
        cwd: f.directory,
        env: { PI_CODING_AGENT_DIR: f.agentDirectory },
        args: ["--approve", "--session-dir", f.directory, "-e", extension],
      });
      cleanups.push(() => client.stop());
      cleanups.push(() => writeFileSync(releaseTool, "release"));
      await client.start();
      const idle = client.waitForIdle(10000);
      await client.prompt("MCP_ROOT");
      await idle;
      childId = SpawnResultSchema.parse(parseJson((await client.getLastAssistantText()) ?? ""))
        .agent.id;
      await started;
      if (mode === "uncooperative tool")
        await expect.poll(() => existsSync(toolStarted)).toBe(true);
      const rootRequests = f.server.requests.filter(
        (request) =>
          !JSON.stringify(
            request.params.messages.filter((message) => message.role === "user").at(-1)?.content,
          ).includes("MCP_HANG_CHILD"),
      );
      expect(rootRequests).toHaveLength(2);
      await expect.poll(() => processes.length).toBe(2);
      const childProcess = processes[1]!;
      let childClosed = false;
      void childProcess.closed.then(() => {
        childClosed = true;
      });
      expect(() => process.kill(childProcess.pid, 0)).not.toThrow();
      if (mode !== "shutdown") {
        const stopped = client.waitForIdle(10000);
        await client.prompt("STOP_MCP_ROOT");
        await stopped;
        const result = z
          .object({
            agent: z.object({
              id: z.string(),
              status: z.literal("cancelled"),
              transcriptPath: z.string(),
              cleanupFailure: z
                .object({ category: z.literal("cleanup"), phase: z.literal("cleanup") })
                .optional(),
            }),
          })
          .parse(parseJson((await client.getLastAssistantText()) ?? ""));
        expect(result.agent.id).toBe(childId);
        expect(readFileSync(result.agent.transcriptPath, "utf8")).toContain("MCP_HANG_CHILD");
        if (mode === "uncooperative tool") {
          expect(readFileSync(result.agent.transcriptPath, "utf8")).toContain(
            "ignore_cancellation",
          );
          expect(result.agent.cleanupFailure).toEqual({ category: "cleanup", phase: "cleanup" });
          await expect.poll(() => childClosed, { timeout: 1500 }).toBe(true);
          writeFileSync(releaseTool, "release");
        }
        await childProcess.closed;
        expect(() => process.kill(processes[0]!.pid, 0)).not.toThrow();
      } else {
        await client.stop();
        await Promise.all(processes.map((entry) => entry.closed));
      }
      await expect
        .poll(
          () => {
            try {
              process.kill(childProcess.pid, 0);
              return true;
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
              throw error;
            }
          },
          { timeout: 3000 },
        )
        .toBe(false);
    },
    30000,
  );
});
