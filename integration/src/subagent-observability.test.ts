import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgentPaths, SessionManager, type Logger, type Runtime } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { SubagentDiagnosticSchema } from "../../packages/core/src/session/subagent-diagnostics.js";
import { lastToolText, startFakeModel, type ModelAction } from "./fake-model.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const example = path.join(repository, "example/subagent-debugging");
const rootPrompt = "ROOT_PRIVATE_PROMPT";
const childPrompt = "CHILD_PRIVATE_TASK";
const grandchildPrompt = "GRANDCHILD_PRIVATE_TASK";
const grandchildAnswer = "GRANDCHILD_DISTINCTIVE_ANSWER";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("subagent diagnostics (real Pi and patched pi-subagents)", () => {
  test.each(["completed", "error"] as const)(
    "retains a %s grandchild's transcript and ancestry after shutdown",
    async (outcome) => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), "subagent-observability-"));
      cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
      const records: { message: string; data?: unknown }[] = [];
      const logger: Logger = {
        log: (message, data) => {
          records.push({ message, data });
        },
        warning: (message, data) => {
          records.push({ message, data });
        },
        error: (message, data) => {
          records.push({ message, data });
        },
      };
      const failureDetails = "PRIVATE_PROVIDER_REJECTION";
      const rejectingServer = createServer((_request, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: failureDetails, type: "authentication_error" } }),
        );
      });
      await new Promise<void>((resolve) => rejectingServer.listen(0, "127.0.0.1", resolve));
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            rejectingServer.closeAllConnections();
            rejectingServer.close(() => resolve());
          }),
      );
      const address = rejectingServer.address();
      if (!address || typeof address === "string")
        throw new Error("Rejecting fixture did not listen");
      const server = await startFakeModel((request): ModelAction[] => {
        const user = [...request.messages].reverse().find((message) => message.role === "user");
        const prompt = JSON.stringify(user?.content);
        if (prompt?.includes(grandchildPrompt)) return [{ text: grandchildAnswer }];
        if (request.messages.some((message) => message.role === "tool")) {
          return [
            {
              text: lastToolText(request).includes(grandchildAnswer)
                ? `CHILD_FINISHED ${grandchildAnswer}`
                : "ROOT_FINISHED",
            },
          ];
        }
        return [
          {
            toolCall: {
              name: "Agent",
              args: {
                subagent_type: "general-purpose",
                prompt: prompt?.includes(childPrompt) ? grandchildPrompt : childPrompt,
                description: "Private delegated task",
                run_in_background: false,
                ...(outcome === "error" && prompt?.includes(childPrompt)
                  ? { model: "rejected/fake-1" }
                  : {}),
              },
            },
          },
        ];
      });
      cleanups.push(() => server.close());
      const runtime = local();
      const observingRuntime: Runtime = {
        ...runtime,
        spawn: (spec) =>
          runtime.spawn({
            ...spec,
            env: {
              ...spec.env,
              PATH: `${path.join(example, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
              PI_SUBAGENTS_OUTPUT_DIR: path.join(spec.cwd, "subagent-transcripts"),
            },
          }),
      };
      const manager = new SessionManager({
        paths: createAgentPaths(workspace, "test"),
        runtime: observingRuntime,
        logger,
        prepareSession: ({ cwd }) => {
          const agentDirectory = path.join(cwd, ".pi/agents");
          mkdirSync(agentDirectory, { recursive: true });
          writeFileSync(
            path.join(agentDirectory, "general-purpose.md"),
            [
              "---",
              "name: general-purpose",
              "description: Delegated integration worker",
              "allowed_subagents: [general-purpose]",
              "persist_session: true",
              "output_transcript: true",
              "---",
              "Complete the delegated task.",
            ].join("\n"),
          );
          writeFileSync(
            path.join(cwd, ".pi/subagents.json"),
            JSON.stringify({
              maxSubagentDepth: 3,
              workflowsEnabled: false,
            }),
          );
        },
        setupSession: () => ({
          pi: {
            model: "fake/fake-1",
            thinking: "off",
            extensions: [
              path.join(example, "dist/subagents.js"),
              path.join(example, "dist/observe-subagents.js"),
            ],
            models: {
              providers: {
                fake: {
                  baseUrl: server.url,
                  api: "openai-completions",
                  apiKey: "credential-free-fixture",
                  models: [{ id: "fake-1" }],
                },
                rejected: {
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  api: "openai-completions",
                  apiKey: "credential-free-fixture",
                  models: [{ id: "fake-1" }],
                },
              },
            },
          },
        }),
      });
      cleanups.push(() => manager.stopAll());

      await manager.namespace("integration").run("nested", rootPrompt, { timeoutMs: 60_000 });
      await manager.stopAll();

      const schema = SubagentDiagnosticSchema.extend({ rootSessionId: z.string().min(1).max(512) });
      const diagnostics = records.flatMap(({ data }) => {
        const parsed = schema.safeParse(data);
        return parsed.success ? [parsed.data] : [];
      });
      const started = diagnostics.filter((record) => record.event === "started");
      const finished = diagnostics.filter((record) => record.event === "finished");
      expect(started).toHaveLength(2);
      expect(finished).toHaveLength(2);
      const child = finished.find((record) => record.parentAgentId === null);
      const grandchild = finished.find((record) => record.parentAgentId !== null);
      expect(child).toBeDefined();
      expect(grandchild).toBeDefined();
      expect(grandchild!.parentAgentId).toBe(child!.agentId);
      expect(grandchild!.rootSessionId).toBe(child!.rootSessionId);
      expect(new Set(started.map((record) => record.agentId))).toEqual(
        new Set(finished.map((record) => record.agentId)),
      );
      const transcriptRoot = path.join(
        workspace,
        "test/sessions/integration/nested/subagent-transcripts",
      );
      expect(child!.status).toBe("completed");
      expect(grandchild!.status).toBe(outcome);
      for (const record of finished) {
        expect(record.transcriptPath).toBeTypeOf("string");
        const transcript = record.transcriptPath!;
        expect(transcript).toMatch(/\.output$/);
        expect(path.relative(transcriptRoot, transcript)).not.toMatch(/^\.\.|^\//);
        expect(existsSync(transcript)).toBe(true);
        expect(readFileSync(transcript, "utf-8")).toContain(
          outcome === "error" ? failureDetails : grandchildAnswer,
        );
      }
      const logs = JSON.stringify(records);
      for (const privateText of [
        rootPrompt,
        childPrompt,
        grandchildPrompt,
        grandchildAnswer,
        failureDetails,
      ]) {
        expect(logs).not.toContain(privateText);
      }
      expect(
        server.requests.some(
          ({ params }) =>
            params.tools?.some((tool) => tool.function.name === "Agent") &&
            JSON.stringify(params.messages).includes(childPrompt),
        ),
      ).toBe(true);
    },
    120_000,
  );
});
