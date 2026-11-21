import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  createAgent,
  tool,
  type Runtime,
  type PiOptions,
  type RuntimeProcess,
  type SessionRef,
} from "@picco-agent/core";
import { cron, type JobRun } from "@picco-agent/plugin-cron";

const TURN_TIMEOUT_MS = 240_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Process and provider boundaries used by the cron smoke fixture.
 */
interface CronSmokeOptions {
  runtime: Runtime;
  pi: PiOptions;
}

/**
 * Follow cron tools into a background worker, then reload its job after an agent restart.
 */
export async function runCronSmoke(opts: CronSmokeOptions): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.homedir(), ".picco-cron-smoke-"));
  const name = "cron-smoke";
  const jobId = "smoke-job";
  const secret = `cron-${randomBytes(8).toString("hex")}`;
  const workers: { ref: SessionRef; process: RuntimeProcess }[] = [];
  const calls: SessionRef[] = [];
  const baseRuntime = opts.runtime;
  const runtime: Runtime = {
    ...baseRuntime,
    async spawn(spec) {
      const worker = await baseRuntime.spawn(spec);
      workers.push({ ref: spec.ref, process: worker });
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
  const pi = opts.pi;
  const jobPrompt =
    'Call cron_probe with prefix "smoke-" exactly once. Reply with exactly its result. ' +
    "Do not create or run any cron jobs.";
  const jobFile = path.join(dataDir, name, "plugins", "cron", `${jobId}.yaml`);

  try {
    for (const restarted of [false, true]) {
      const completed = Promise.withResolvers<void>();
      const runs: JobRun[] = [];
      let expectedRuns: number | undefined;
      const agent = createAgent({
        name,
        dataDir,
        runtime,
        pi,
        tools: [probe],
        plugins: [
          cron({
            onRunComplete: (run) => {
              runs.push(run);
              if (runs.length === expectedRuns) completed.resolve();
            },
          }),
        ],
      });
      const previousCalls = calls.length;
      const previousWorkers = workers.length;
      try {
        await agent.start({ handleSignals: false });
        const prompt = restarted
          ? `Call cron_list with exactly {} (it takes no parameters) and confirm it contains ${jobId}. Wait for that result, then call cron_run with exactly ${JSON.stringify({ id: jobId })} once. Do not add or update any jobs.`
          : `Call cron_add exactly once with ${JSON.stringify({
              id: jobId,
              description: "Cron smoke job",
              schedule: "0 0 0 1 1 *",
              type: "agent",
              prompt: jobPrompt,
              timeout: TURN_TIMEOUT_MS / 1_000,
            })}. Wait for its successful result before calling cron_run for ${jobId} exactly once.`;
        const setupDir = path.join(dataDir, name, "sessions", "host", "setup");
        const previousTriggerResults = restarted ? readTriggerResults(setupDir).length : 0;
        const turn = agent.sessions.run("setup", prompt, { timeoutMs: TURN_TIMEOUT_MS });
        const result = await turn;
        const events: string[] = [];
        const triggerCallIds: string[] = [];
        for await (const event of turn.events) {
          if (event.type === "tool_end" && !event.isError) {
            events.push(event.tool);
            if (event.tool === "cron_run") triggerCallIds.push(event.toolCallId);
          }
        }
        assert.ok(events.includes(restarted ? "cron_list" : "cron_add"), result.text);
        assert.ok(events.includes("cron_run"), result.text);
        if (restarted) {
          for (const toolName of ["cron_add", "cron_update", "cron_remove"]) {
            assert.ok(!events.includes(toolName), `Persisted job must run without ${toolName}`);
          }
        }
        const triggerResults = readTriggerResults(setupDir).slice(previousTriggerResults);
        assert.deepEqual(
          triggerResults.map((message) => message.toolCallId),
          triggerCallIds,
        );
        expectedRuns = 0;
        for (const message of triggerResults) {
          assert.equal(message.isError, false);
          const text = message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          if (text === `Job "${jobId}" triggered — running in the background.`) expectedRuns++;
          else assert.equal(text, `Job "${jobId}" skipped — concurrency limit 1 reached.`);
        }
        assert.ok(expectedRuns > 0, result.text);
        assert.ok(runs.length <= expectedRuns, "More completed runs than accepted triggers");
        if (runs.length === expectedRuns) completed.resolve();
        await withDeadline(completed.promise, TURN_TIMEOUT_MS);
        assert.equal(runs.length, expectedRuns);
        assert.equal(new Set(runs.map((run) => run.id)).size, expectedRuns);
        assert.equal(new Set(runs.map((run) => run.executionId)).size, expectedRuns);
        for (const run of runs) {
          assert.ok(run.id);
          assert.ok(run.executionId);
          assert.equal(run.jobId, jobId);
          assert.equal(run.status, "success", run.error);
          assert.equal(run.output?.trim(), `smoke-${secret}`);
        }
        const freshCalls = calls.slice(previousCalls);
        const freshWorkers = workers.slice(previousWorkers);
        const cronWorkers = freshWorkers.filter((worker) => worker.ref.source === "cron");
        assert.equal(freshCalls.length, expectedRuns);
        assert.equal(freshWorkers.length, expectedRuns + 1);
        assert.equal(cronWorkers.length, expectedRuns);
        assert.ok(cronWorkers.every((worker) => !worker.process.alive));
        assert.equal(new Set(calls.map((ref) => ref.key)).size, calls.length);
        assert.deepEqual(
          freshCalls.map((ref) => ref.key).sort(),
          cronWorkers.map((worker) => worker.ref.key).sort(),
        );
        for (const ref of freshCalls) {
          assert.equal(ref.source, "cron");
          assert.ok(ref.key.startsWith(`${jobId}/`));
          const sessionDir = path.join(dataDir, name, "sessions", ref.source, ref.key);
          assert.ok(readdirSync(sessionDir).some((file) => file.endsWith(".jsonl")));
        }
        assert.ok(readFileSync(jobFile, "utf8").includes("cron_probe"));
        console.log(
          `[cron] PASS: ${restarted ? "persisted job reloaded" : "job created"} and all accepted background runs completed`,
        );
      } finally {
        await agent.stop();
        await withDeadline(
          Promise.all(workers.map((worker) => worker.process.exited)),
          SHUTDOWN_TIMEOUT_MS,
        );
        assert.ok(workers.every((worker) => !worker.process.alive));
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

/**
 * Read actual trigger responses, including skips that do not start a worker.
 */
function readTriggerResults(sessionDir: string) {
  return readdirSync(sessionDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) => parseSessionEntries(readFileSync(path.join(sessionDir, file), "utf8")))
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "cron_run"
        ? [entry.message]
        : [],
    );
}
