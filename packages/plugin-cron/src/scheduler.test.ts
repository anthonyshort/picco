import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";
import type { AgentJobConfig, JobConfig, ScriptJobConfig } from "./loader.js";
import { JobLoader } from "./loader.js";
import { CronHistory } from "./history.js";
import { ExecutionFailure } from "@picco-agent/core";
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
    maxConcurrentRuns: 1,
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
    maxConcurrentRuns: 1,
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

describe("bounded concurrency", () => {
  test("admits three runs, skips excess triggers and retains counts across reload, update and readd", async () => {
    const pending: ReturnType<typeof Promise.withResolvers<string>>[] = [];
    scheduler = new JobScheduler({
      loader,
      runAgent: (opts) => {
        runAgentCalls.push(opts);
        const result = Promise.withResolvers<string>();
        pending.push(result);
        return result.promise;
      },
      runScript: async () => "unused",
      onRunComplete: (run) => void runs.push(run),
    });
    await scheduler.addJob(agentJob({ maxConcurrentRuns: 3 }));
    const first = scheduler.fireJob("agent-job");
    await writeJobFile(agentJob({ maxConcurrentRuns: 3, prompt: "new prompt" }));
    await scheduler.reload();
    const second = scheduler.fireJob("agent-job");
    const third = scheduler.fireJob("agent-job");
    expect(runAgentCalls.map((call) => call.prompt)).toEqual(["hello", "new prompt", "new prompt"]);
    expect(scheduler.listJobs()[0]).toMatchObject({ activeCount: 3, maxConcurrentRuns: 3 });
    expect(scheduler.triggerJob("agent-job")).toMatch(/skipped.*limit 3/);
    await scheduler.fireJob("agent-job");
    expect(pending).toHaveLength(3);
    await scheduler.updateJob("agent-job", { maxConcurrentRuns: 1 });
    expect(scheduler.triggerJob("agent-job")).toMatch(/skipped.*limit 1/);
    await scheduler.removeJob("agent-job");
    await scheduler.addJob(agentJob({ maxConcurrentRuns: 1 }));
    expect(scheduler.listJobs()[0].activeCount).toBe(3);
    expect(scheduler.triggerJob("agent-job")).toMatch(/skipped/);
    pending.forEach((result, index) => result.resolve(`run-${index}`));
    await Promise.all([first, second, third]);
    expect(runs.map((run) => run.output).sort()).toEqual(["run-0", "run-1", "run-2"]);
    expect(scheduler.listJobs()[0]).toMatchObject({ activeCount: 0, fireCount: 3 });
    expect(pending).toHaveLength(3);
  });

  test("keeps the slot until completion reporting settles and releases it after failures", async () => {
    const completion = Promise.withResolvers<void>();
    const reporting = Promise.withResolvers<void>();
    scheduler = new JobScheduler({
      loader,
      runAgent: async () => {
        throw new Error("run failed");
      },
      runScript: async () => "unused",
      onRunComplete: async () => {
        reporting.resolve();
        await completion.promise;
        throw new Error("report failed");
      },
    });
    await scheduler.addJob(agentJob());
    const run = scheduler.fireJob("agent-job");
    await reporting.promise;
    expect(scheduler.details("agent-job").activeRuns).toEqual([]);
    expect(scheduler.listJobs()[0]).toMatchObject({ activeCount: 1, runningCount: 0 });
    expect(scheduler.triggerJob("agent-job")).toMatch(/skipped/);
    completion.resolve();
    await run;
    expect(scheduler.listJobs()[0]).toMatchObject({ activeCount: 0, fireCount: 1 });
  });
});

describe("persistent inspection", () => {
  test("records admission before work, links its execution and persists terminal output before observers", async () => {
    const history = new CronHistory({ file: path.join(cronDir, "history.sqlite") });
    const work = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    scheduler = new JobScheduler({
      loader,
      history,
      runAgent: ({ reportExecution }) => {
        expect(history.list()[0]).toMatchObject({
          status: "running",
          definition: { model: "local/first" },
        });
        reportExecution?.("execution-123");
        started.resolve();
        return work.promise;
      },
      runScript: async () => "unused",
      onRunComplete: () => {
        expect(history.list()[0]).toMatchObject({ status: "success", output: "complete" });
      },
    });
    await scheduler.addJob(agentJob({ model: "local/first" }));
    const operation = scheduler.fireJob("agent-job");
    await started.promise;
    expect(scheduler.details("agent-job")).toMatchObject({
      activeRuns: [{ executionId: "execution-123", status: "running" }],
    });
    await scheduler.updateJob("agent-job", { model: "local/second" });
    work.resolve("complete");
    await operation;
    const detail = scheduler.details("agent-job");
    expect(detail).toMatchObject({
      definition: { model: "local/second" },
      activeRuns: [],
      recentRuns: [{ definition: { model: "local/first" } }],
    });
    await scheduler.removeJob("agent-job");
    expect(scheduler.details("agent-job")).toMatchObject({
      found: true,
      scheduled: false,
      definition: null,
    });
    await scheduler.stop();
    const restored = new CronHistory({ file: path.join(cronDir, "history.sqlite") });
    try {
      expect(restored.list()[0]).toMatchObject({
        executionId: "execution-123",
        output: "complete",
      });
    } finally {
      restored.close();
    }
  });

  test("skipped triggers are recorded separately and do not run or count as completions", async () => {
    const work = Promise.withResolvers<string>();
    scheduler = new JobScheduler({
      loader,
      runAgent: () => work.promise,
      runScript: async () => "unused",
      onRunComplete: () => {},
    });
    await scheduler.addJob(agentJob());
    const first = scheduler.fireJob("agent-job");
    expect(scheduler.triggerJob("agent-job")).toContain("skipped");
    expect(scheduler.details("agent-job").recentRuns).toEqual([
      expect.objectContaining({ status: "skipped", reason: "Concurrency limit reached" }),
      expect.objectContaining({ status: "running" }),
    ]);
    expect(scheduler.listJobs()[0].fireCount).toBe(0);
    work.resolve("done");
    await first;
    expect(scheduler.listJobs()[0].fireCount).toBe(1);
  });

  test("failed history admission prevents side effects and releases capacity", async () => {
    const history = new CronHistory();
    let invoked = false;
    scheduler = new JobScheduler({
      loader,
      history,
      runAgent: async () => {
        invoked = true;
        return "unused";
      },
      runScript: async () => "unused",
      onRunComplete: () => {},
    });
    await scheduler.addJob(agentJob());
    history.close();
    await expect(scheduler.fireJob("agent-job")).rejects.toThrow("history is closed");
    expect(invoked).toBe(false);
    expect(scheduler.triggerJob("agent-job")).toContain("triggered");
  });

  test("shutdown is bounded while pending work retains exclusive history ownership", async () => {
    const file = path.join(cronDir, "pending-history.sqlite");
    const history = new CronHistory({ file });
    const work = Promise.withResolvers<string>();
    scheduler = new JobScheduler({
      loader,
      history,
      runAgent: () => work.promise,
      runScript: async () => "unused",
      onRunComplete: () => {},
    });
    await scheduler.addJob(agentJob());
    const running = scheduler.fireJob("agent-job");
    vi.useFakeTimers();
    try {
      const stopping = scheduler.stop();
      const failure = expect(stopping).rejects.toThrow("pending work retains history ownership");
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(() => new CronHistory({ file })).toThrow("locked");
      expect(scheduler.triggerJob("agent-job")).toContain("stopped");
      work.resolve("finished");
      await running;
      await scheduler.stop();
      const reopened = new CronHistory({ file });
      expect(reopened.list()[0].status).toBe("success");
      reopened.close();
    } finally {
      vi.useRealTimers();
      work.resolve("finished");
      await running;
    }
  });

  test("retains primary and finalisation failures as separate history evidence", async () => {
    scheduler = new JobScheduler({
      loader,
      runAgent: async () => {
        throw new ExecutionFailure(
          { id: "execution-failed", session: { source: "cron", key: "example" } },
          new Error("provider failed"),
          [new Error("claim cleanup failed")],
        );
      },
      runScript: async () => "unused",
      onRunComplete: () => {},
    });
    await scheduler.addJob(agentJob());
    await scheduler.fireJob("agent-job");
    expect(scheduler.details("agent-job").recentRuns[0]).toMatchObject({
      status: "error",
      error: "provider failed",
      finalisationErrors: ["claim cleanup failed"],
    });
  });
});
