import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { createFakePluginContext, type FakePluginContext } from "@picco-agent/core/testing";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { cron, type JobRun } from "./index.js";

let dir: string;
let ctx: FakePluginContext;
let running: ReturnType<typeof cron>[];
let runs: JobRun[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cronplugin-test-"));
  ctx = createFakePluginContext({ source: "cron" });
  running = [];
  runs = [];
});

afterEach(async () => {
  for (const plugin of running) await plugin.stop!();
  await rm(dir, { recursive: true, force: true });
});

const toolCtx: ToolContext = {
  logger: silentLogger(),
  caller: { kind: "host" },
};

async function startCron(options: Parameters<typeof cron>[0] = {}) {
  const plugin = cron({ jobDir: dir, onRunComplete: (run) => void runs.push(run), ...options });
  await plugin.start!(ctx);
  running.push(plugin);
  return plugin;
}

function findTool(plugin: ReturnType<typeof cron>, name: string) {
  const tool = plugin.tools!.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
}

describe("cron plugin", () => {
  test("registers all five cron tools", () => {
    const plugin = cron({ jobDir: dir });
    expect(plugin.tools!.map((t) => t.name)).toEqual([
      "cron_list",
      "cron_add",
      "cron_update",
      "cron_remove",
      "cron_run",
    ]);
  });

  test("tools fail clearly before the plugin starts", () => {
    const plugin = cron({ jobDir: dir });
    expect(() => findTool(plugin, "cron_list").execute({}, toolCtx)).toThrow("not started");
  });

  test("loads existing YAML jobs unchanged on start", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "briefing.yaml"),
      yamlStringify({
        id: "briefing",
        type: "agent",
        description: "Morning briefing",
        schedule: "0 0 7 * * *",
        prompt: "Summarize the news.",
        enabled: false,
      }),
    );

    const plugin = await startCron();
    const listed = await findTool(plugin, "cron_list").execute({}, toolCtx);

    expect(listed).toContain("briefing");
    expect(listed).toContain("0 0 7 * * *");
    expect(listed).toContain("disabled");
  });

  test("agent jobs run through ctx.sessions.run and report to onRunComplete", async () => {
    const plugin = await startCron();

    const added = await findTool(plugin, "cron_add").execute(
      {
        id: "hello",
        description: "test job",
        schedule: "0 0 9 * * *",
        type: "agent",
        prompt: "say hello",
      },
      toolCtx,
    );
    expect(added).toContain("added successfully");

    const triggered = await findTool(plugin, "cron_run").execute({ id: "hello" }, toolCtx);
    expect(triggered).toContain("triggered");

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ jobId: "hello", status: "success" });
    expect(ctx.turns).toEqual([
      {
        source: "cron",
        key: expect.stringMatching(/^hello\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/),
        prompt: "say hello",
        user: undefined,
        // No model/thinking on the job — nothing overrides the agent-wide pi config.
        session: { pi: {} },
      },
    ]);
  });

  test("agent jobs carry model and thinking through to the session's pi overrides", async () => {
    const plugin = await startCron();

    await findTool(plugin, "cron_add").execute(
      {
        id: "tuned",
        description: "tuned job",
        schedule: "0 0 9 * * *",
        type: "agent",
        prompt: "go",
        model: "anthropic/claude-sonnet-4-5",
        thinking: "high",
      },
      toolCtx,
    );
    await findTool(plugin, "cron_run").execute({ id: "tuned" }, toolCtx);

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(ctx.turns[0]).toMatchObject({
      session: { pi: { model: "anthropic/claude-sonnet-4-5", thinking: "high" } },
    });
  });

  test("the heartbeat picks up YAML files written directly to disk", async () => {
    const plugin = await startCron({ heartbeatMs: 25 });

    await writeFile(
      path.join(dir, "external.yaml"),
      yamlStringify({
        id: "external",
        type: "script",
        description: "written behind the plugin's back",
        schedule: "0 0 8 * * *",
        command: "echo hi",
        enabled: false,
      }),
    );

    await vi.waitFor(async () => {
      const listed = await findTool(plugin, "cron_list").execute({}, toolCtx);
      expect(listed).toContain("external");
    });
  });

  test("script jobs run through ctx.runtime.exec and report their output", async () => {
    const plugin = await startCron();

    await findTool(plugin, "cron_add").execute(
      {
        id: "disk",
        description: "disk check",
        schedule: "0 0 9 * * *",
        type: "script",
        command: "df -h",
      },
      toolCtx,
    );
    await findTool(plugin, "cron_run").execute({ id: "disk" }, toolCtx);

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ jobId: "disk", status: "success" });
    // The scheduler's default script timeout (300s) travels through to ctx.runtime.exec.
    expect(ctx.execs).toEqual([{ command: "df -h", timeoutMs: 300_000 }]);
    expect(ctx.turns).toEqual([]);
  });
});
