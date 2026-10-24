import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgent, type Logger } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { lastToolText, startFakeModel } from "./fake-model.js";

const ChildSchema = z.object({ agent: z.object({ id: z.string() }) });
const FailureEventSchema = z.object({
  agentName: z.literal("observability"),
  source: z.literal("host"),
  key: z.literal("auth"),
  requestId: z.literal("auth-request"),
  workerId: z.string(),
  rootSessionId: z.string(),
  rootTranscriptPath: z.string(),
  piSessionId: z.string(),
  executionId: z.string(),
  agentId: z.string(),
  parentAgentId: z.null(),
  category: z.literal("authentication"),
  statusCode: z.literal(401),
  reason: z.literal("authentication_rejected"),
  transcriptPath: z.string(),
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Picco observability", () => {
  test("session replacement refreshes root identity before a child authentication failure", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "observability-int-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const extension = path.join(directory, "fresh.mjs");
    writeFileSync(
      extension,
      `export default (pi) => {
        pi.registerCommand("fresh", {
          handler: async (_args, ctx) => { await ctx.newSession(); },
        });
      };`,
    );
    const server = await startFakeModel((request) => {
      if (request.model === "child")
        return [{ error: { status: 401, message: "private provider error body" } }];
      const previous = lastToolText(request);
      if (!previous)
        return [
          {
            toolCall: {
              name: "spawn_agent",
              args: { prompt: "private child task", model: "fake/child" },
            },
          },
        ];
      const child = ChildSchema.safeParse(JSON.parse(previous));
      if (child.success && !previous.includes('"outputAvailable"'))
        return [
          {
            toolCall: {
              name: "get_agent_result",
              args: { agentId: child.data.agent.id, wait: true },
            },
          },
        ];
      return [{ text: previous }];
    });
    cleanups.push(() => server.close());
    const entries: { event: string; fields: unknown }[] = [];
    const write = (event: string, fields?: unknown) => {
      entries.push({ event, fields });
    };
    const logger: Logger = { log: write, warning: write, error: write };
    const agent = createAgent({
      name: "observability",
      dataDir: directory,
      runtime: local(),
      logger,
      pi: {
        model: "fake/parent",
        extensions: [
          extension,
          path.resolve(import.meta.dirname, "../../packages/headless-subagents/dist/index.js"),
        ],
        settings: { retry: { enabled: false } },
        models: {
          providers: {
            fake: {
              baseUrl: server.url,
              api: "openai-completions",
              apiKey: "private-dummy-api-key",
              models: [{ id: "parent" }, { id: "child" }],
            },
          },
        },
      },
    });
    cleanups.push(() => agent.stop());
    await agent.start({ handleSignals: false });
    await agent.sessions.run("auth", "/fresh", { requestId: "replace-request" });
    const initial = z
      .object({ piSessionId: z.string(), transcriptPath: z.string() })
      .parse(entries.find((entry) => entry.event === "worker.state")?.fields);
    const result = await agent.sessions.run("auth", "private root task", {
      requestId: "auth-request",
    });
    const child = z
      .object({
        agent: z.object({
          id: z.string(),
          status: z.literal("failed"),
          failure: z.object({ category: z.literal("authentication") }),
        }),
      })
      .parse(JSON.parse(result.text));
    const failure = FailureEventSchema.parse(
      entries.find((entry) => entry.event === "agent.failed")?.fields,
    );
    expect(failure.agentId).toBe(child.agent.id);
    expect(failure.rootSessionId).not.toBe(initial.piSessionId);
    expect(failure.piSessionId).toBe(failure.rootSessionId);
    expect(failure.rootTranscriptPath).not.toBe(initial.transcriptPath);
    expect(entries).toContainEqual({
      event: "request.started",
      fields: expect.objectContaining({
        requestId: "auth-request",
        piSessionId: failure.rootSessionId,
        transcriptPath: failure.rootTranscriptPath,
      }),
    });
    expect(readFileSync(failure.transcriptPath, "utf8")).toContain("private provider error body");
    expect(entries).toContainEqual({
      event: "model.failed",
      fields: expect.objectContaining({ agentId: child.agent.id, category: "authentication" }),
    });
    expect(entries).not.toContainEqual({ event: "worker.exited", fields: expect.anything() });
    expect(JSON.stringify(entries)).not.toContain("private");
    await agent.stop();
    expect(entries).toContainEqual({
      event: "worker.exited",
      fields: expect.objectContaining({ expected: true, stopReason: "host_shutdown" }),
    });
  }, 30000);
});
