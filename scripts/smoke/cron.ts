import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import {
  createAgent,
  tool,
  type Runtime,
  type RuntimeProcess,
  type SessionRef,
} from "@picco-agent/core";
import { cron, type JobRun } from "@picco-agent/plugin-cron";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { createSmokeModel } from "./model.js";

const TURN_TIMEOUT_MS = 240_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

await runCronSmoke();

/**
 * Follow cron tools into a background worker, then reload its job after an agent restart.
 */
async function runCronSmoke(): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.homedir(), ".picco-cron-smoke-"));
  const name = "cron-smoke";
  const jobId = "smoke-job";
  const secret = `cron-${randomBytes(8).toString("hex")}`;
  const workers: RuntimeProcess[] = [];
  const calls: SessionRef[] = [];
  const baseRuntime = bwrap({ env: ["OPENROUTER_API_KEY"] });
  const runtime: Runtime = {
    ...baseRuntime,
    async spawn(spec) {
      const worker = await baseRuntime.spawn(spec);
      workers.push(worker);
      return worker;
    },
  };
  const probe = tool({
    name: "cron_probe",
    description: "Return the cron smoke sentinel with the supplied prefix.",
    input: z.object({ prefix: z.string() }),
    execute({ prefix }, ctx) {
      assert.equal(ctx.caller.kind, "session");
      if (ctx.caller.kind !== "session") throw new Error("Expected a session caller");
      calls.push(ctx.caller.ref);
      assert.equal(prefix, "smoke-");
      return `${prefix}${secret}`;
    },
  });
  const pi = createSmokeModel();
  const jobPrompt =
    'Call cron_probe with prefix "smoke-" exactly once. Reply with exactly its result. ' +
    "Do not create or run any cron jobs.";
  const jobFile = path.join(dataDir, name, "plugins", "cron", `${jobId}.yaml`);

  try {
    for (const restarted of [false, true]) {
      const completed = Promise.withResolvers<JobRun>();
      const agent = createAgent({
        name,
        dataDir,
        runtime,
        pi,
        tools: [probe],
        plugins: [cron({ onRunComplete: (run) => completed.resolve(run) })],
      });
      const previousCalls = calls.length;
      const previousWorkers = workers.length;
      try {
        await agent.start({ handleSignals: false });
        const prompt = restarted
          ? `Call cron_list and confirm it contains ${jobId}, then call cron_run for ${jobId} exactly once. Do not add or update any jobs.`
          : `Call cron_add exactly once with ${JSON.stringify({
              id: jobId,
              description: "Cron smoke job",
              schedule: "0 0 0 1 1 *",
              type: "agent",
              prompt: jobPrompt,
              timeout: TURN_TIMEOUT_MS / 1_000,
            })}. Wait for its successful result before calling cron_run for ${jobId} exactly once.`;
        const turn = agent.sessions.run("setup", prompt, { timeoutMs: TURN_TIMEOUT_MS });
        await turn;
        const events: string[] = [];
        for await (const event of turn.events) {
          if (event.type === "tool_end" && !event.isError) events.push(event.tool);
        }
        assert.ok(events.includes(restarted ? "cron_list" : "cron_add"));
        assert.ok(events.includes("cron_run"));
        const run = await withDeadline(completed.promise, TURN_TIMEOUT_MS);
        assert.equal(run.jobId, jobId);
        assert.equal(run.status, "success", run.error);
        assert.equal(run.output?.trim(), `smoke-${secret}`);
        assert.equal(calls.length, previousCalls + 1);
        const ref = calls.at(-1)!;
        assert.equal(ref.source, "cron");
        assert.ok(ref.key.startsWith(`${jobId}/`));
        assert.equal(workers.length, previousWorkers + 2);
        assert.ok(readFileSync(jobFile, "utf8").includes("cron_probe"));
        const sessionDir = path.join(dataDir, name, "sessions", ref.source, ref.key);
        assert.ok(readdirSync(sessionDir).some((file) => file.endsWith(".jsonl")));
        if (restarted) assert.notEqual(calls[0]!.key, ref.key);
        console.log(
          `[cron] PASS: ${restarted ? "persisted job reloaded" : "job created"} and background worker completed`,
        );
      } finally {
        await agent.stop();
        await withDeadline(
          Promise.all(workers.map((worker) => worker.exited)),
          SHUTDOWN_TIMEOUT_MS,
        );
        assert.ok(workers.every((worker) => !worker.alive));
      }
    }
    console.log("[cron] PASS: all foreground and cron workers exited after shutdown");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Bound callback and process-exit waits without leaving a timer after completion.
 */
async function withDeadline<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new Error(`Cron smoke timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}
