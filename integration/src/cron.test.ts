import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { describe, expect, test, vi } from "vitest";
import {
  createAgent,
  tool,
  type Runtime,
  type RuntimeProcess,
  type SessionRef,
} from "@picco-agent/core";
import { cron, type JobRun } from "@picco-agent/plugin-cron";
import { local } from "@picco-agent/runtime-local";
import { lastToolText, startFakeModel } from "./fake-model.js";

describe("cron plugin with real Pi workers", () => {
  test("reports a dead background worker, then runs the persisted job successfully and stops its workers", async () => {
    const dataDir = mkdtempSync(path.join(os.homedir(), ".picco-cron-integration-"));
    const workers: { ref: SessionRef; process: RuntimeProcess }[] = [];
    const runs: JobRun[] = [];
    const calls: SessionRef[] = [];
    let failBackground = true;
    let hangingTurns = 0;
    const model = await startFakeModel((params) => {
      const prompt = JSON.stringify(
        params.messages.findLast((message) => message.role === "user")?.content,
      );
      const toolResults = params.messages.filter((message) => message.role === "tool");
      if (prompt?.includes("background-probe")) {
        if (failBackground) {
          hangingTurns++;
          return [{ hang: true }];
        }
        return toolResults.length
          ? [{ text: lastToolText(params) }]
          : [{ toolCall: { name: "cron_probe", args: {} } }];
      }
      if (prompt?.includes("retry-job")) {
        return params.messages.at(-1)?.role === "tool"
          ? [{ text: "triggered" }]
          : [{ toolCall: { name: "cron_run", args: { id: "probe" } } }];
      }
      if (toolResults.length === 0) {
        return [
          {
            toolCall: {
              name: "cron_add",
              args: {
                id: "probe",
                description: "Recovery integration job",
                schedule: "0 0 0 1 1 *",
                type: "agent",
                prompt: "background-probe",
                timeout: 30,
              },
            },
          },
        ];
      }
      return toolResults.length === 1
        ? [{ toolCall: { name: "cron_run", args: { id: "probe" } } }]
        : [{ text: "triggered" }];
    });
    const baseRuntime = local();
    const runtime: Runtime = {
      ...baseRuntime,
      async spawn(spec) {
        const process = await baseRuntime.spawn(spec);
        workers.push({ ref: spec.ref, process });
        return process;
      },
    };
    const agent = createAgent({
      name: "cron-integration",
      dataDir,
      runtime,
      pi: {
        model: "fake/fake-1",
        thinking: "off",
        models: {
          providers: {
            fake: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "test-key",
              models: [{ id: "fake-1" }],
            },
          },
        },
      },
      plugins: [cron({ onRunComplete: (run) => void runs.push(run) })],
      tools: [
        tool({
          name: "cron_probe",
          description: "Return the integration sentinel.",
          input: z.object({}),
          execute(input, ctx) {
            expect(input).toEqual({});
            if (ctx.caller.kind !== "session") throw new Error("Expected a session caller");
            calls.push(ctx.caller.ref);
            return "cron-recovered";
          },
        }),
      ],
    });
    try {
      await agent.start({ handleSignals: false });
      await agent.sessions.run("setup", "create-job", { timeoutMs: 30_000 });
      await vi.waitFor(() => expect(hangingTurns).toBe(1), { timeout: 10_000 });
      const failedWorker = workers.find((worker) => worker.ref.source === "cron")!;
      await failedWorker.process.kill();
      await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000 });
      expect(runs[0]).toMatchObject({ jobId: "probe", status: "error" });
      expect(runs[0]!.error).toContain("exited");
      expect(calls).toEqual([]);

      failBackground = false;
      await agent.sessions.run("setup", "retry-job", { timeoutMs: 30_000 });
      await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 10_000 });
      expect(runs[1]).toMatchObject({
        jobId: "probe",
        status: "success",
        output: "cron-recovered",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.source).toBe("cron");
      expect(calls[0]!.key).not.toBe(failedWorker.ref.key);
      expect(workers.filter((worker) => worker.ref.source === "cron")).toHaveLength(2);

      failBackground = true;
      await agent.sessions.run("setup", "retry-job", { timeoutMs: 30_000 });
      await vi.waitFor(() => expect(hangingTurns).toBe(2), { timeout: 10_000 });
      await agent.stop();
      await vi.waitFor(() => expect(runs).toHaveLength(3));
      expect(runs[2]).toMatchObject({ jobId: "probe", status: "error" });
      expect(calls).toHaveLength(1);
      await vi.waitFor(() => expect(workers.every((worker) => !worker.process.alive)).toBe(true));
    } finally {
      await agent.stop();
      await model.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
