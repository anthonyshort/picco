import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createAgent, silentLogger, type Plugin } from "@picco-agent/core";
import {
  githubFeedback,
  type GithubExecute,
  type GithubFeedbackResult,
} from "@picco-agent/plugin-github-reviews";
import { local } from "@picco-agent/runtime-local";
import { z } from "zod";
import { startFakeModel } from "./fake-model.js";

describe("feedback plugin with a real Pi worker", () => {
  test("discovers reviews, writes an artifact, declares completion and retains deduplication after restart", async () => {
    const root = mkdtempSync(path.join(os.homedir(), ".picco-feedback-integration-"));
    const proof = path.join(root, "proof.txt");
    const outcomes: GithubFeedbackResult[] = [];
    let workerRequests = 0;
    const model = await startFakeModel((params) => {
      workerRequests++;
      const results = params.messages.filter((message) => message.role === "tool");
      if (!results.length)
        return [{ toolCall: { name: "write", args: { path: proof, content: "FEEDBACK_OK" } } }];
      if (results.length === 1)
        return [
          {
            toolCall: {
              name: "github_feedback_complete",
              args: { summary: "Fixture artifact verified" },
            },
          },
        ];
      return [{ text: "Completed fixture" }];
    });
    const execute: GithubExecute = async (args, input) => {
      expect(args).toEqual(["api", "graphql", "--input", "-"]);
      const request = z.object({ query: z.string() }).parse(JSON.parse(input!));
      const rateLimit = {
        cost: 1,
        remaining: 4000,
        resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      const pull = {
        repository: { nameWithOwner: "fixture/project" },
        number: 1,
        url: "https://github.com/fixture/project/pull/1",
        title: "Fixture",
        state: "OPEN",
        author: { login: "owner" },
        headRefOid: "a".repeat(40),
        headRepository: { nameWithOwner: "owner/fork" },
        headRefName: "feature",
      };
      const data = { viewer: { login: "owner" }, rateLimit };
      if (request.query.includes("AuthoredFeedback"))
        return JSON.stringify({
          data: {
            ...data,
            viewer: {
              ...data.viewer,
              pullRequests: {
                nodes: [pull],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      return JSON.stringify({
        data: {
          ...data,
          repository: {
            nameWithOwner: "fixture/project",
            pullRequest: {
              ...pull,
              reviews: {
                nodes: [
                  {
                    id: "review-1",
                    url: `${pull.url}#review-1`,
                    author: { login: "reviewer" },
                    submittedAt: "2026-10-28T00:00:00Z",
                    state: "CHANGES_REQUESTED",
                    body: "A fixture",
                    comments: { totalCount: 1 },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    };
    const feedbackPlugins: Plugin[] = [];
    const makeAgent = () => {
      const feedback = githubFeedback({
        enabled: true,
        feedbackDirectory: path.join(root, "feedback"),
        pollIntervalMs: 1000,
        debounceMs: 1000,
        maxWaitMs: 1000,
        github: { execute },
        onRunComplete: (result) => {
          outcomes.push(result);
        },
      });
      feedbackPlugins.push(feedback);
      return createAgent({
        name: "feedback-integration",
        dataDir: path.join(root, "agent"),
        runtime: local(),
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
        plugins: [feedback],
      });
    };
    const first = makeAgent();
    let restarted: ReturnType<typeof makeAgent> | undefined;
    try {
      await first.start({ handleSignals: false });
      await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 20_000 });
      expect(readFileSync(proof, "utf8")).toBe("FEEDBACK_OK");
      expect(outcomes[0].status).toBe("completed");
      expect(workerRequests).toBe(3);
      expect(first.sessions.list()).toEqual([]);
      await first.stop();
      const callsBeforeRestart = workerRequests;
      restarted = makeAgent();
      await restarted.start({ handleSignals: false });
      // A manual poll exercises persisted deduplication without waiting for another timer.
      const poll = feedbackPlugins
        .at(-1)!
        .tools!.find((entry) => entry.name === "github_feedback_poll")!;
      const result = await poll.execute(poll.input.parse({}), {
        caller: { kind: "host" },
        logger: silentLogger(),
      });
      const status = z
        .object({
          activeRuns: z.array(z.string()).max(1),
          queue: z
            .array(
              z.object({
                key: z.string(),
                blockedRunId: z.string().nullable(),
                pending: z.number(),
              }),
            )
            .max(100_000),
        })
        .parse(JSON.parse(String(result)));
      expect(status.activeRuns).toEqual([]);
      expect(status.queue).toEqual([{ key: "fixture/project#1", blockedRunId: null, pending: 0 }]);
      expect(workerRequests).toBe(callsBeforeRestart);
      expect(outcomes).toHaveLength(1);
    } finally {
      await restarted?.stop();
      await first.stop();
      await model.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
