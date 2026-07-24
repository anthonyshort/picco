import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";
import type { AgentJobConfig, JobConfig, ScriptJobConfig } from "./loader.js";
import { JobLoader } from "./loader.js";
import { JobScheduler, type JobRun, type RunAgent } from "./scheduler.js";

let cronDir: string;
let loader: JobLoader;
let scheduler: JobScheduler;
let runs: JobRun[];
let runAgentCalls: Parameters<RunAgent>[0][];
let runScriptCalls: { jobId: string; command: string; timeoutMs: number }[];

beforeEach(async () => {
  cronDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
  loader = new JobLoader(cronDir);
  runs = [];
  runAgentCalls = [];
  runScriptCalls = [];
  scheduler = new JobScheduler({
    loader,
    runAgent: async (opts) => {
      runAgentCalls.push(opts);
      return `agent-ran:${opts.prompt}`;
    },
    runScript: async (opts) => {
      runScriptCalls.push(opts);
      return `script-ran:${opts.command}`;
    },
    onRunComplete: (run) => void runs.push(run),
  });
});

afterEach(async () => {
  scheduler.stopAllTimers();
  await rm(cronDir, { recursive: true, force: true });
});

function agentJob(overrides: Partial<AgentJobConfig> = {}): AgentJobConfig {
  return {
    id: "agent-job",
    type: "agent",
    description: "an agent job",
    schedule: "0 */5 * * * *",
    enabled: true,
    prompt: "hello",
    ...overrides,
  };
}

function scriptJob(overrides: Partial<ScriptJobConfig> = {}): ScriptJobConfig {
  return {
    id: "script-job",
    type: "script",
    description: "a script job",
    schedule: "0 */5 * * * *",
    enabled: true,
    command: "echo hello",
    timeout: 10,
    ...overrides,
  };
}

function writeJobFile(config: JobConfig): Promise<void> {
  return writeFile(path.join(loader.jobDir, `${config.id}.yaml`), yamlStringify(config));
}

/**
 * Fire a loaded job and wait for it to complete (schedule bypassed).
 */
async function runNow(s: JobScheduler, id: string): Promise<void> {
  if (!s.listJobs().some((job) => job.id === id)) throw new Error(`job ${id} is not loaded`);
  await s.fireJob(id);
}

describe("reload reconciliation", () => {
  test("arms a new job found on disk", async () => {
    await writeJobFile(scriptJob({ id: "a" }));
    await scheduler.reload();

    const jobs = scheduler.listJobs();
    expect(jobs.map((j) => j.id)).toEqual(["a"]);
  });

  test("addJob refuses an id that is already loaded instead of lying about it", async () => {
    await scheduler.addJob(scriptJob({ id: "dupe", command: "echo one" }));

    await expect(scheduler.addJob(scriptJob({ id: "dupe", command: "echo two" }))).rejects.toThrow(
      /already exists/,
    );
  });

  test("reloads a job when its file changes", async () => {
    await writeJobFile(scriptJob({ id: "a", schedule: "0 */5 * * * *" }));
    await scheduler.reload();

    await writeJobFile(scriptJob({ id: "a", schedule: "0 */10 * * * *" }));
    await scheduler.reload();

    const jobs = scheduler.listJobs();
    expect(jobs.find((j) => j.id === "a")?.schedule).toBe("0 */10 * * * *");
  });

  test("removes a job deleted from disk", async () => {
    await writeJobFile(scriptJob({ id: "a" }));
    await scheduler.reload();

    await unlink(path.join(loader.jobDir, "a.yaml"));
    await scheduler.reload();

    expect(scheduler.listJobs()).toEqual([]);
  });
});

describe("agent jobs", () => {
  test("runs an agent job through the injected runAgent and reports the run", async () => {
    await scheduler.addJob(agentJob({ id: "ag", prompt: "do it" }));

    await runNow(scheduler, "ag");

    expect(runAgentCalls).toEqual([expect.objectContaining({ jobId: "ag", prompt: "do it" })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jobId: "ag",
      status: "success",
      // The agent's final text rides on the run report.
      output: "agent-ran:do it",
    });
    // In-memory stats power cron_list.
    const state = scheduler.listJobs().find((j) => j.id === "ag");
    expect(state?.fireCount).toBe(1);
    expect(state?.lastRun).not.toBeNull();
  });

  test("passes model, thinking and timeoutMs from config to runAgent", async () => {
    await scheduler.addJob(
      agentJob({
        id: "ag-params",
        prompt: "do it",
        model: "anthropic/claude-sonnet-4-20250514",
        thinking: "high",
        timeout: 900,
      }),
    );

    await runNow(scheduler, "ag-params");

    const call = runAgentCalls.find((c) => c.jobId === "ag-params");
    expect(call).toBeDefined();
    expect(call?.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(call?.thinking).toBe("high");
    expect(call?.timeoutMs).toBe(900_000);
  });

  test("omits optional params when not set in config", async () => {
    await scheduler.addJob(agentJob({ id: "ag-minimal", prompt: "go" }));
    await runNow(scheduler, "ag-minimal");

    const call = runAgentCalls.find((c) => c.jobId === "ag-minimal");
    expect(call).toBeDefined();
    expect(call?.model).toBeUndefined();
    expect(call?.thinking).toBeUndefined();
    expect(call?.timeoutMs).toBeUndefined();
  });

  test("reports an error run when the agent throws", async () => {
    const failed: JobRun[] = [];
    const failing = new JobScheduler({
      loader,
      runAgent: async () => {
        throw new Error("boom");
      },
      runScript: async () => "",
      onRunComplete: (run) => void failed.push(run),
    });
    try {
      await failing.addJob(agentJob({ id: "bad" }));
      await runNow(failing, "bad");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ jobId: "bad", status: "error", error: "boom" });
      expect(failed[0]!.output).toBeUndefined();
    } finally {
      failing.stopAllTimers();
    }
  });
});

describe("script jobs", () => {
  test("runs the command through the injected runScript and reports its output", async () => {
    await scheduler.addJob(scriptJob({ id: "sc", command: "echo hello-world", timeout: 10 }));

    await runNow(scheduler, "sc");

    expect(runScriptCalls).toEqual([
      { jobId: "sc", command: "echo hello-world", timeoutMs: 10_000 },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jobId: "sc",
      status: "success",
      output: "script-ran:echo hello-world",
    });
  });

  test("reports an error run when the script runner throws", async () => {
    const failed: JobRun[] = [];
    const failing = new JobScheduler({
      loader,
      runAgent: async () => "",
      runScript: async () => {
        throw new Error("exit status 1");
      },
      onRunComplete: (run) => void failed.push(run),
    });
    try {
      await failing.addJob(scriptJob({ id: "fail", command: "exit 1" }));
      await runNow(failing, "fail");

      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ status: "error" });
      expect(failed[0]!.error).toContain("exit status 1");
    } finally {
      failing.stopAllTimers();
    }
  });
});

describe("onRunComplete", () => {
  test("an async callback rejection is contained — the run loop survives", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejecting = new JobScheduler({
      loader,
      runAgent: async () => "ok",
      runScript: async () => "ok",
      onRunComplete: async () => {
        throw new Error("db is down");
      },
    });
    try {
      await rejecting.addJob(scriptJob({ id: "sink" }));

      await expect(rejecting.fireJob("sink")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("onRunComplete failed"));
    } finally {
      rejecting.stopAllTimers();
      errorSpy.mockRestore();
    }
  });
});

describe("overlap skipping", () => {
  test("a second fire while the job is still running is skipped", async () => {
    await scheduler.addJob(scriptJob({ id: "ov" }));

    // Both fires start in the same tick; the first marks the job running synchronously,
    // so the second must skip.
    await Promise.all([scheduler.fireJob("ov"), scheduler.fireJob("ov")]);

    expect(runs).toHaveLength(1);
    expect(runScriptCalls).toHaveLength(1);
  });
});

describe("triggerJob", () => {
  test("fires in the background and reports the trigger immediately", async () => {
    await scheduler.addJob(scriptJob({ id: "bg", command: "echo bg" }));

    const msg = scheduler.triggerJob("bg");

    expect(msg).toContain("triggered");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
  });

  test("reports unknown and disabled jobs without firing", async () => {
    expect(scheduler.triggerJob("nope")).toContain("not found");

    await scheduler.addJob(scriptJob({ id: "off", enabled: true }));
    await scheduler.updateJob("off", { enabled: false });
    expect(scheduler.triggerJob("off")).toContain("disabled");
    expect(runScriptCalls).toHaveLength(0);
  });
});

describe("updateJob", () => {
  test("updates a job and reloads timers", async () => {
    await scheduler.addJob(scriptJob({ id: "upd", schedule: "0 */5 * * * *", description: "old" }));

    const msg = await scheduler.updateJob("upd", {
      schedule: "0 */10 * * * *",
      description: "new desc",
    });

    expect(msg).toContain("updated");
    const job = scheduler.listJobs().find((j) => j.id === "upd");
    expect(job?.schedule).toBe("0 */10 * * * *");

    // Verify the config on disk
    const config = loader.get("upd");
    expect(config?.description).toBe("new desc");
    expect(config?.schedule).toBe("0 */10 * * * *");
  });

  test("throws for a missing job", async () => {
    await expect(scheduler.updateJob("missing", { description: "x" })).rejects.toThrow(/not found/);
  });

  test("disables and re-enables a job (persisted to disk)", async () => {
    await scheduler.addJob(scriptJob({ id: "tog", command: "echo t" }));

    await scheduler.updateJob("tog", { enabled: false });
    expect(loader.get("tog")?.enabled).toBe(false);
    const onDisk = await readFile(path.join(loader.jobDir, "tog.yaml"), "utf-8");
    expect(onDisk).toContain("enabled: false");
    expect(scheduler.triggerJob("tog")).toContain("disabled");

    await scheduler.updateJob("tog", { enabled: true });
    expect(scheduler.triggerJob("tog")).toContain("triggered");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
  });
});

describe("timer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("fires a scheduled job when time advances and stops when disarmed", async () => {
    await scheduler.addJob(agentJob({ id: "iv", schedule: "* * * * * *", prompt: "tick" }));
    expect(runAgentCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runAgentCalls.length).toBeGreaterThanOrEqual(1);

    scheduler.stopAllTimers();
    const fired = runAgentCalls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runAgentCalls).toHaveLength(fired);
  });
});
