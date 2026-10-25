import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createAgent,
  type AgentHandle,
  type Runtime,
  type RuntimeProcess,
} from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { startFakeModel, type FakeModelServer, type ModelScript } from "./fake-model.js";

const cleanups: (() => Promise<void> | void)[] = [];

interface Harness {
  agent: AgentHandle;
  processes: RuntimeProcess[];
  server: FakeModelServer;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("agent lifecycle with real workers", () => {
  test("a worker killed mid-turn fails promptly and resumes completed history on the next turn", async () => {
    const requested = Promise.withResolvers<void>();
    const harness = await startHarness(() => [{ text: "remembered" }]);
    await harness.agent.sessions.run("recovery", "Remember the codeword: kestrel.", {
      timeoutMs: 60_000,
    });

    harness.server.setScript(() => {
      requested.resolve();
      return [{ hang: true }];
    });
    const interrupted = harness.agent.sessions.run("recovery", "Wait for another instruction.", {
      timeoutMs: 60_000,
    });
    const failure = expect(interrupted).rejects.toThrow("exited");
    await requested.promise;
    await harness.processes[0]!.kill();
    await failure;

    harness.server.setScript(() => [{ text: "recovered" }]);
    const result = await harness.agent.sessions.run("recovery", "What was the codeword?", {
      timeoutMs: 60_000,
    });
    expect(result.text).toBe("recovered");
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes[0]!.alive).toBe(false);
    expect(harness.processes[1]!.alive).toBe(true);
    expect(JSON.stringify(harness.server.requests.at(-1)!.params.messages)).toContain("kestrel");
  }, 120_000);

  test("shutdown settles an active turn, kills idle and active workers, and refuses new work", async () => {
    const requested = Promise.withResolvers<void>();
    const harness = await startHarness(() => [{ text: "idle" }]);
    await harness.agent.sessions.run("idle", "Finish this turn.", { timeoutMs: 60_000 });
    harness.server.setScript(() => {
      requested.resolve();
      return [{ hang: true }];
    });
    const active = harness.agent.sessions.run("active", "Wait for another instruction.", {
      timeoutMs: 60_000,
    });
    const failure = expect(active).rejects.toThrow("agent shutdown");
    await requested.promise;

    await harness.agent.stop();
    await failure;
    expect(harness.processes).toHaveLength(2);
    expect(harness.processes.every((worker) => !worker.alive)).toBe(true);
    await Promise.all(harness.processes.map((worker) => worker.exited));
    expect(() => harness.agent.sessions.run("after-stop", "Should not start.")).toThrow();
    expect(harness.processes).toHaveLength(2);
    await harness.agent.stop();
  }, 120_000);
});

/**
 * Start the production agent against a scripted model, recording real worker lifetimes.
 */
async function startHarness(script: ModelScript): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "lifecycle-int-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await startFakeModel(script);
  cleanups.push(() => server.close());
  const processes: RuntimeProcess[] = [];
  const baseRuntime = local();
  const runtime: Runtime = {
    ...baseRuntime,
    async spawn(spec) {
      const worker = await baseRuntime.spawn(spec);
      processes.push(worker);
      return worker;
    },
  };
  const agent = createAgent({
    name: "lifecycle-integration",
    dataDir,
    runtime,
    pi: {
      model: "fake/fake-1",
      thinking: "off",
      models: {
        providers: {
          fake: {
            baseUrl: server.url,
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "fake-1" }],
          },
        },
      },
    },
  });
  cleanups.push(() => agent.stop());
  await agent.start({ handleSignals: false });
  return { agent, processes, server };
}
