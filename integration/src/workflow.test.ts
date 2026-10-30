import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { local } from "@picco-agent/runtime-local";
import {
  SessionManager,
  ToolBridge,
  createAgentPaths,
  tool,
  type WorkerEvent,
  type PrepareExecutionContext,
} from "@picco-agent/core";
import { bridgeExtensionBundle } from "./bridge-bundle.js";
import { startFakeModel, type ModelAction } from "./fake-model.js";
import { observeWorkflows } from "./workflow-observer.js";

const extension = process.env.PICCO_SUBAGENTS_EXTENSION;
const piBinary = process.env.PICCO_PI_BIN;
if (piBinary && path.basename(piBinary) !== "pi") {
  throw new Error("PICCO_PI_BIN must point to an executable named pi");
}
const workerPath = piBinary ? `${path.dirname(piBinary)}:${process.env.PATH}` : process.env.PATH;
const piVersion = extension
  ? execFileSync("pi", ["--version"], {
      env: { ...process.env, PATH: workerPath },
      encoding: "utf8",
    }).trim()
  : "not configured";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!extension)(
  `saved workflow execution ownership (Pi ${piVersion} and pi-subagents)`,
  () => {
    it.each([false, true])(
      "should preserve delayed publication authority with holds=%s",
      async (held) => {
        const workspace = mkdtempSync(path.join(os.tmpdir(), "workflow-int-"));
        cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
        const firstSettlement = Promise.withResolvers<void>();
        const childStarted = Promise.withResolvers<void>();
        const rejectedPublication = Promise.withResolvers<void>();
        const releaseChild = Promise.withResolvers<void>();
        cleanups.push(() => releaseChild.resolve());
        const events: WorkerEvent[] = [];
        const publications: string[] = [];
        const declarations: string[] = [];
        const calls: string[] = [];
        const script = `export const meta = {name: "ownership-proof", description: "Local execution proof"}; return await agent("CHILD_EXECUTION_PROOF", {model: "fake/fake-1"});`;
        let parentCalls = 0;
        const server = await startFakeModel(async (request): Promise<ModelAction[]> => {
          const userText = request.messages
            .filter((message) => message.role === "user")
            .map((message) => JSON.stringify(message.content))
            .join("\n");
          if (
            userText.includes("CHILD_EXECUTION_PROOF") &&
            !userText.includes("Start the review")
          ) {
            childStarted.resolve();
            await releaseChild.promise;
            if (!request.messages.some((message) => message.role === "tool")) {
              return [{ toolCall: { name: "github_comment", args: {} } }];
            }
            if (JSON.stringify(request.messages).includes("No running execution"))
              rejectedPublication.resolve();
            return [{ text: "child publication finished" }];
          }
          parentCalls++;
          if (parentCalls === 1)
            return [{ toolCall: { name: "SubagentWorkflow", args: { script } } }];
          if (parentCalls === 2) return [{ text: "started in background" }];
          if (
            !request.messages.some(
              (message) => message.role === "tool" && String(message.content).includes("declared"),
            )
          ) {
            return [{ toolCall: { name: "github_review_complete", args: {} } }];
          }
          return [{ text: "review completed" }];
        });
        cleanups.push(() => server.close());
        const tools = [
          tool({
            name: "github_comment",
            description: "Fake local publication",
            input: z.object({}),
            execute(input, ctx) {
              void input;
              publications.push(ctx.execution!.id);
              calls.push("publication");
              return "published";
            },
          }),
          tool({
            name: "github_review_complete",
            description: "Fake local completion declaration",
            input: z.object({}),
            execute(input, ctx) {
              void input;
              declarations.push(ctx.execution!.id);
              calls.push("declaration");
              return "declared";
            },
          }),
        ];
        let manager!: SessionManager;
        const bridge = new ToolBridge({
          tools: new Map(tools.map((value) => [value.name, value])),
          executionContext: (ref) => manager.currentExecution(ref),
        });
        await bridge.start();
        cleanups.push(() => bridge.stop());
        const observe = (ctx: PrepareExecutionContext) => {
          const adapter = held ? observeWorkflows(ctx) : undefined;
          return {
            onEvent(event: WorkerEvent) {
              events.push(event);
              adapter?.onEvent(event);
              if (event.type === "agent_settled") firstSettlement.resolve();
            },
          };
        };
        manager = new SessionManager({
          paths: createAgentPaths(workspace, "proof"),
          runtime: local(),
          readyDelayMs: 0,
          bridge: { url: bridge.callUrl() },
          observers: [observe],
          finalisers: [
            {
              name: "proof",
              run: () => {
                calls.push("finalise");
              },
            },
          ],
          prepareSession({ cwd }) {
            const directory = path.join(cwd, ".pi/extensions");
            mkdirSync(directory, { recursive: true });
            writeFileSync(
              path.join(directory, "bridge.js"),
              readFileSync(bridgeExtensionBundle(), "utf8"),
            );
            writeFileSync(
              path.join(directory, "subagents.ts"),
              `export { default } from ${JSON.stringify(extension)};`,
            );
          },
          setupSession({ ref }) {
            return {
              env: workerPath ? { PATH: workerPath } : undefined,
              bridgeToken: bridge.issueToken(ref),
              tools: tools.map((value) => ({
                name: value.name,
                description: value.description,
                inputSchema: z.toJSONSchema(value.input),
              })),
              pi: {
                model: "fake/fake-1",
                models: {
                  providers: {
                    fake: {
                      baseUrl: server.url,
                      api: "openai-completions",
                      apiKey: "local-test",
                      models: [{ id: "fake-1" }],
                    },
                  },
                },
              },
            };
          },
          revokeSession: (ref) => bridge.releaseSession(ref),
          teardownSession: (ref) => bridge.releaseSession(ref),
          quiesceExecution: (execution) => bridge.settleExecution(execution.id),
        });
        cleanups.push(() => manager.stopAll());
        const turn = manager
          .namespace("github-reviews")
          .run("proof", "Start the review", { timeoutMs: 20_000 });
        await firstSettlement.promise;
        await childStarted.promise;
        if (!held) await turn;
        expect(publications).toEqual([]);
        expect(declarations).toEqual([]);
        releaseChild.resolve();
        if (held) {
          const result = await turn;
          expect(result.text).toBe("review completed");
          expect(publications).toEqual([result.executionId]);
          expect(declarations).toEqual([result.executionId]);
          expect(calls).toEqual(["publication", "declaration", "finalise"]);
          expect(events.map((event) => event.type)).toContain("custom_message");
          expect(manager.list()).toEqual([]);
        } else {
          // The detached child can finish, but its host call no longer has execution authority.
          await rejectedPublication.promise;
          expect(publications).toEqual([]);
          expect(calls).toEqual(["finalise"]);
        }
      },
    );
  },
);
