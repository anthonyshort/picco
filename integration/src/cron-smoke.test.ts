import * as z from "zod";
import { describe, expect, test, vi } from "vitest";
import type { Runtime, RuntimeProcess } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { runCronSmoke } from "../../scripts/smoke/cron-smoke.js";
import { lastToolText, startFakeModel } from "./fake-model.js";

describe("cron smoke fixture", () => {
  test.each(["once", "repeat after completion", "repeat while active"] as const)(
    "checks every accepted run when the model triggers %s",
    async (scenario) => {
      const cronWorkers: RuntimeProcess[] = [];
      const responses: string[] = [];
      let releaseBackground = Promise.withResolvers<void>();
      const model = await startFakeModel(async (params) => {
        const userIndex = params.messages.findLastIndex((message) => message.role === "user");
        const content = params.messages[userIndex]?.content;
        const prompt =
          typeof content === "string"
            ? content
            : z
                .array(z.object({ type: z.literal("text"), text: z.string() }))
                .max(100)
                .parse(content)
                .map((part) => part.text)
                .join("\n");
        const toolResults = params.messages
          .slice(userIndex + 1)
          .filter((message) => message.role === "tool");
        if (prompt.startsWith("Call cron_probe")) {
          if (toolResults.length) return [{ text: lastToolText(params) }];
          if (
            scenario === "repeat while active" ||
            (scenario === "repeat after completion" && cronWorkers.length % 2 === 0)
          )
            await releaseBackground.promise;
          return [{ toolCall: { name: "cron_probe", args: { prefix: "smoke-" } } }];
        }
        if (toolResults.length === 0) {
          releaseBackground = Promise.withResolvers<void>();
          if (prompt.includes("Call cron_add")) {
            const match = prompt.match(/with (\{.*\})\. Wait/);
            expect(match).not.toBeNull();
            return [{ toolCall: { name: "cron_add", args: JSON.parse(match![1]!) } }];
          }
          return [{ toolCall: { name: "cron_list", args: {} } }];
        }
        if (toolResults.length === 1) {
          return [{ toolCall: { name: "cron_run", args: { id: "smoke-job" } } }];
        }
        responses.push(lastToolText(params));
        if (toolResults.length === 2 && scenario !== "once") {
          if (scenario === "repeat after completion") {
            await vi.waitFor(() => expect(cronWorkers.at(-1)?.alive).toBe(false), {
              timeout: 10_000,
            });
          }
          return [{ toolCall: { name: "cron_run", args: { id: "smoke-job" } } }];
        }
        releaseBackground.resolve();
        return [{ text: "Finished setup." }];
      });
      const baseRuntime = local();
      const runtime: Runtime = {
        ...baseRuntime,
        async spawn(spec) {
          const process = await baseRuntime.spawn(spec);
          if (spec.ref.source === "cron") cronWorkers.push(process);
          return process;
        },
      };
      try {
        await runCronSmoke({
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
        });
        expect(cronWorkers).toHaveLength(scenario === "repeat after completion" ? 4 : 2);
        expect(cronWorkers.every((worker) => !worker.alive)).toBe(true);
        expect(responses.filter((response) => response.includes("triggered"))).toHaveLength(
          scenario === "repeat after completion" ? 4 : 2,
        );
        expect(responses.filter((response) => response.includes("skipped"))).toHaveLength(
          scenario === "repeat while active" ? 2 : 0,
        );
      } finally {
        releaseBackground.resolve();
        await model.close();
      }
    },
    60_000,
  );
});
