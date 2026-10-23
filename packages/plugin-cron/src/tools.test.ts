import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { JobLoader } from "./loader.js";
import { JobScheduler } from "./scheduler.js";
import { buildCronTools, cronAdd, cronList, cronUpdate } from "./tools.js";

const toolCtx: ToolContext = {
  logger: silentLogger(),
  caller: { kind: "host" },
};

let cronDir: string;
let loader: JobLoader;
let scheduler: JobScheduler;

beforeEach(async () => {
  cronDir = await mkdtemp(path.join(os.tmpdir(), "cron-test-"));
  loader = new JobLoader(cronDir);
  scheduler = new JobScheduler({
    loader,
    runAgent: async ({ prompt }) => `agent-ran:${prompt}`,
    runScript: async ({ command }) => `script-ran:${command}`,
    onRunComplete: () => {},
  });
});

afterEach(async () => {
  scheduler.stopAllTimers();
  await rm(cronDir, { recursive: true, force: true });
});

describe("cronList", () => {
  test("reports when no jobs are loaded", () => {
    expect(cronList(scheduler)).toBe("No cron jobs loaded.");
  });

  test("renders a markdown row per job", async () => {
    await scheduler.addJob({
      id: "j1",
      type: "script",
      description: "d",
      schedule: "0 */5 * * * *",
      command: "echo hi",
      timeout: 10,
      enabled: true,
    });

    const out = cronList(scheduler);
    expect(out).toContain("| Name | Type | Schedule | Status | Active | Limit | Last Run | Runs |");
    expect(out).toContain("| j1 | script | 0 */5 * * * * | enabled | 0 | 1 | never | 0 |");
  });
});

describe("cronAdd", () => {
  test("adds an agent job and returns a success message", async () => {
    const res = await cronAdd(scheduler, {
      id: "ag",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "agent",
      prompt: "hi",
    });

    expect(res).toContain("added successfully");
    const ids = scheduler.listJobs().map((j) => j.id);
    expect(ids).toContain("ag");
  });

  test("returns the validation error for an invalid id without persisting", async () => {
    const res = await cronAdd(scheduler, {
      id: "bad id",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "script",
      command: "echo hi",
    });

    expect(res).toContain("alphanumeric");
    const ids = scheduler.listJobs().map((j) => j.id);
    expect(ids).not.toContain("bad id");
  });

  test("returns the validation error for an invalid schedule without persisting", async () => {
    const res = await cronAdd(scheduler, {
      id: "bad-sched",
      description: "d",
      schedule: "5m",
      type: "script",
      command: "echo hi",
    });

    expect(res).toContain("Invalid schedule");
    expect(scheduler.listJobs()).toEqual([]);
  });

  test("refuses an agent job without a prompt instead of saving an empty one", async () => {
    const res = await cronAdd(scheduler, {
      id: "no-prompt",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "agent",
    });

    expect(res).toContain('require a "prompt"');
    expect(scheduler.listJobs()).toEqual([]);
  });

  test("refuses a script job without a command instead of saving an empty one", async () => {
    const res = await cronAdd(scheduler, {
      id: "no-command",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "script",
    });

    expect(res).toContain('require a "command"');
    expect(scheduler.listJobs()).toEqual([]);
  });

  test("reports a duplicate id as an error pointing at cron_update", async () => {
    const params = {
      id: "twice",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "script" as const,
      command: "echo hi",
    };
    await cronAdd(scheduler, params);

    const res = await cronAdd(scheduler, params);
    expect(res).toContain("already exists");
    expect(res).toContain("cron_update");
  });
});

describe("cronUpdate", () => {
  test("updates the schedule on an existing job", async () => {
    await cronAdd(scheduler, {
      id: "updt",
      description: "d",
      schedule: "0 */5 * * * *",
      type: "script",
      command: "echo hi",
    });

    const res = await cronUpdate(scheduler, { id: "updt", schedule: "0 */10 * * * *" });
    expect(res).toContain("updated");

    const jobs = scheduler.listJobs();
    expect(jobs.find((j) => j.id === "updt")?.schedule).toBe("0 */10 * * * *");
  });

  test("returns an error for a missing job", async () => {
    const res = await cronUpdate(scheduler, { id: "missing", schedule: "0 */5 * * * *" });
    expect(res).toContain("not found");
  });
});

describe("cron_remove", () => {
  test("removing a missing job returns the error as the tool result", async () => {
    const remove = buildCronTools(() => ({ scheduler })).find((t) => t.name === "cron_remove")!;

    const res = await remove.execute({ id: "missing" }, toolCtx);
    expect(res).toContain("not found");
  });
});

test("cron tools persist concurrency and omitted updates preserve the current limit", async () => {
  const tools = buildCronTools(() => ({ scheduler }));
  const add = tools.find((tool) => tool.name === "cron_add")!;
  const update = tools.find((tool) => tool.name === "cron_update")!;
  const input = add.input.parse({
    id: "parallel",
    description: "d",
    type: "agent",
    prompt: "review",
    schedule: "0 */5 * * * *",
    maxConcurrentRuns: 3,
  });
  await add.execute(input, toolCtx);
  await update.execute(update.input.parse({ id: "parallel", description: "updated" }), toolCtx);
  await update.execute(update.input.parse({ id: "parallel", schedule: "0 */10 * * * *" }), toolCtx);
  await loader.refresh();
  expect(loader.get("parallel")?.maxConcurrentRuns).toBe(3);
  await update.execute(update.input.parse({ id: "parallel", maxConcurrentRuns: 2 }), toolCtx);
  await loader.refresh();
  expect(loader.get("parallel")?.maxConcurrentRuns).toBe(2);
  expect(update.input.safeParse({ id: "parallel", maxConcurrentRuns: 11 }).success).toBe(false);
});
