import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "./coordinator.js";
import {
  AgentRecordSchema,
  SettingsSchema,
  type AgentOwner,
  type AgentRecord,
  type ChildRunner,
  type ChildRunnerOptions,
  type DiagnosticEvent,
} from "./types.js";
import type { ManifestStore } from "./manifest.js";

/**
 * In-memory implementation of the persistence boundary, including observable write failures.
 */
class FakeManifestStore implements ManifestStore {
  executionId = "execution";
  manifestPath = "/traces/root/manifest.json";
  records = new Map<string, AgentRecord>();
  closed = false;
  failWrites = false;
  pathsFor(id: string) {
    return {
      transcriptDirectory: `/traces/${id}`,
    };
  }
  create(record: AgentRecord) {
    this.update(record);
  }
  update(record: AgentRecord) {
    if (this.failWrites) throw new Error("disk full");
    this.records.set(record.id, AgentRecordSchema.parse(record));
  }
  close() {
    this.closed = true;
  }
}

/**
 * A run controlled by the test through the public runner boundary.
 */
class FakeChildRunner implements ChildRunner {
  model = "fake/model";
  thinking = "medium" as const;
  transcriptPath = "/traces/native.jsonl";
  result = Promise.withResolvers<{
    output: string;
    error?: string;
    aborted?: boolean;
    truncated?: boolean;
  }>();
  started = Promise.withResolvers<void>();
  closed = false;
  stopped = false;
  text = "";
  ignoreAbort = false;
  async run() {
    this.started.resolve();
    return this.result.promise;
  }
  currentOutput() {
    return this.text;
  }
  async abort() {
    this.stopped = true;
    if (!this.ignoreAbort) this.result.resolve({ output: this.text, aborted: true });
  }
  async close() {
    this.closed = true;
  }
}

const owner: AgentOwner<undefined> = {
  id: null,
  context: undefined,
  model: "fake/model",
  thinking: "medium",
  activeTools: [],
  inheritedTools: [],
  settings: {},
};

/**
 * Build real coordination with replaceable SDK and storage boundaries.
 */
function fixture(overrides: Partial<ReturnType<typeof SettingsSchema.parse>> = {}) {
  const store = new FakeManifestStore();
  const runners = new Map<string, FakeChildRunner>();
  const calls = new Map<string, ChildRunnerOptions<undefined>>();
  const diagnostics: DiagnosticEvent[] = [];
  const coordinator = new SubagentCoordinator<undefined>({
    rootSessionId: "root",
    settings: SettingsSchema.parse(overrides),
    store,
    toolsFor: () => [],
    async createRunner(options) {
      const runner = new FakeChildRunner();
      runners.set(options.record.id, runner);
      calls.set(options.record.id, options);
      options.onTranscript(runner.transcriptPath);
      return runner;
    },
    onDiagnostic: (event) => {
      diagnostics.push(event);
    },
  });
  return { store, runners, calls, diagnostics, coordinator };
}

/**
 * A complete assistant message, without a real model request.
 */
function assistant(stopReason: "stop" | "toolUse" | "error" = "stop") {
  return {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "fake",
    model: "model",
    content: [{ type: "text" as const, text: "private answer" }],
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite: 6,
      totalTokens: 18,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    },
  };
}

describe("SubagentCoordinator", () => {
  test("persists identity before SDK startup and keeps children running after spawn returns", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "private task" });
    expect(f.store.records.get(record.id)?.parentAgentId).toBeNull();
    expect(f.diagnostics[0]).toMatchObject({
      version: 1,
      event: "agent.created",
      agentId: record.id,
    });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    expect(f.coordinator.list(null)[0]?.status).toBe("running");
    expect(JSON.stringify(f.diagnostics)).not.toContain("private task");
    runner.result.resolve({ output: "answer" });
    const result = await f.coordinator.result(null, record.id, { wait: true });
    expect(result.agent).toMatchObject({ status: "completed" });
    expect(result.output).toBe("answer");
    expect(runner.closed).toBe(true);
    expect(f.store.records.get(record.id)?.transcriptPath).toBe(runner.transcriptPath);
    await f.coordinator.close();
  });

  test("failed admission persistence is observable without starting or admitting a child", async () => {
    const f = fixture();
    f.store.failWrites = true;
    expect(() => f.coordinator.spawn(owner, { prompt: "task" })).toThrow("disk full");
    expect(f.runners.size).toBe(0);
    expect(f.coordinator.list(null)).toEqual([]);
    expect(f.diagnostics).toMatchObject([
      { event: "persistence.failed", data: { category: "persistence", phase: "persistence" } },
    ]);
    await f.coordinator.close();
  });

  test("counts starting agents at admission and enforces per-call limits before SDK work", async () => {
    const f = fixture({ maxActive: 1, timeoutMs: 1000, maxTurns: 3 });
    const first = f.coordinator.spawn(owner, { prompt: "first" });
    expect(() => f.coordinator.spawn(owner, { prompt: "second" })).toThrow(/capacity/);
    expect(f.runners.size).toBe(1);
    await f.coordinator.stop(null, first.id);
    expect(() => f.coordinator.spawn(owner, { prompt: "third", timeoutMs: 1001 })).toThrow(
      /tighten/,
    );
    expect(() => f.coordinator.spawn(owner, { prompt: "third", maxTurns: 4 })).toThrow(/tighten/);
    await f.coordinator.close();
  });

  test("applies the active limit and depth to descendants without deadlocking their owners", async () => {
    const f = fixture({ maxActive: 2, maxDepth: 2 });
    const parent = f.coordinator.spawn(owner, { prompt: "parent" });
    await f.runners.get(parent.id)!.started.promise;
    const childOwner = { ...owner, id: parent.id };
    const child = f.coordinator.spawn(childOwner, { prompt: "child" });
    await f.runners.get(child.id)!.started.promise;
    expect(() => f.coordinator.spawn(childOwner, { prompt: "excess" })).toThrow(/capacity/);
    expect(() => f.coordinator.spawn({ ...owner, id: child.id }, { prompt: "too deep" })).toThrow(
      /depth/,
    );
    expect(f.coordinator.list(null)).toHaveLength(2);
    expect(f.coordinator.list(parent.id).map((record) => record.id)).toEqual([child.id]);
    await expect(f.coordinator.stop(null, child.id)).rejects.toThrow(/owned/);
    await f.coordinator.stop(null, parent.id);
    expect(f.coordinator.list(null).map((record) => record.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    await f.coordinator.close();
  });

  test("owner completion cancels its unfinished descendants before disposing itself", async () => {
    const f = fixture();
    const parent = f.coordinator.spawn(owner, { prompt: "parent" });
    const parentRunner = f.runners.get(parent.id)!;
    await parentRunner.started.promise;
    const child = f.coordinator.spawn({ ...owner, id: parent.id }, { prompt: "child" });
    const childRunner = f.runners.get(child.id)!;
    await childRunner.started.promise;
    parentRunner.result.resolve({ output: "parent answer" });
    await f.coordinator.result(null, parent.id, { wait: true });
    expect(childRunner.stopped).toBe(true);
    expect(childRunner.closed).toBe(true);
    expect(f.coordinator.list(null).find((record) => record.id === child.id)?.status).toBe(
      "cancelled",
    );
    await f.coordinator.close();
  });

  test("cancelling a result wait neither stops nor consumes the child", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    const abort = new AbortController();
    const waiting = f.coordinator.result(null, record.id, { wait: true, signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow(/wait cancelled/);
    expect(runner.stopped).toBe(false);
    runner.result.resolve({ output: "late answer" });
    expect((await f.coordinator.result(null, record.id, { wait: true })).output).toBe(
      "late answer",
    );
    await f.coordinator.close();
  });

  test("timeout closes a non-cooperative run and retains its partial output", async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 100 });
    try {
      const record = f.coordinator.spawn(owner, { prompt: "task" });
      const runner = f.runners.get(record.id)!;
      runner.ignoreAbort = true;
      runner.text = "partial answer";
      await runner.started.promise;
      await vi.advanceTimersByTimeAsync(100);
      const result = await f.coordinator.result(null, record.id, { wait: true });
      expect(result.agent).toMatchObject({ status: "timed_out", partial: true });
      expect(result.output).toBe("partial answer");
      expect(runner.closed).toBe(true);
      expect(f.diagnostics.some((event) => event.event === "agent.cancellation_requested")).toBe(
        true,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.coordinator.close();
      vi.useRealTimers();
    }
  });

  test("stopping during startup prevents prompting and holds capacity until late SDK cleanup", async () => {
    const store = new FakeManifestStore();
    const ready = Promise.withResolvers<ChildRunner>();
    const runner = new FakeChildRunner();
    const coordinator = new SubagentCoordinator<undefined>({
      rootSessionId: "root",
      settings: SettingsSchema.parse({ maxActive: 1 }),
      store,
      toolsFor: () => [],
      createRunner: () => ready.promise,
    });
    const record = coordinator.spawn(owner, { prompt: "task" });
    const stopping = coordinator.stop(null, record.id);
    expect(() => coordinator.spawn(owner, { prompt: "other" })).toThrow(/capacity/);
    ready.resolve(runner);
    expect((await stopping).status).toBe("cancelled");
    expect(runner.closed).toBe(true);
    expect(runner.stopped).toBe(false);
    expect((await coordinator.result(null, record.id)).output).toBe("");
    await coordinator.close();
  });

  test("root shutdown is bounded for stuck startup and keeps lifecycle state open until late settlement", async () => {
    vi.useFakeTimers();
    const store = new FakeManifestStore();
    const ready = Promise.withResolvers<ChildRunner>();
    const runner = new FakeChildRunner();
    const coordinator = new SubagentCoordinator<undefined>({
      rootSessionId: "root",
      settings: SettingsSchema.parse({}),
      store,
      toolsFor: () => [],
      createRunner: () => ready.promise,
    });
    try {
      coordinator.spawn(owner, { prompt: "task" });
      const closing = expect(coordinator.close()).rejects.toThrow(/shutdown/);
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
      expect(store.closed).toBe(false);
      expect(() => coordinator.spawn(owner, { prompt: "more" })).toThrow(/closed/);
      ready.resolve(runner);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.closed).toBe(true);
      expect(runner.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("turn limits do not relabel a completed final answer but stop another tool loop", async () => {
    const f = fixture({ maxTurns: 1 });
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    const event: AgentSessionEvent = {
      type: "turn_end",
      message: assistant("toolUse"),
      toolResults: [],
    };
    f.calls.get(record.id)!.onEvent(event);
    expect((await f.coordinator.result(null, record.id, { wait: true })).agent.status).toBe(
      "limit_reached",
    );
    const next = f.coordinator.spawn(owner, { prompt: "next" });
    const nextRunner = f.runners.get(next.id)!;
    await nextRunner.started.promise;
    f.calls
      .get(next.id)!
      .onEvent({ type: "turn_end", message: assistant("stop"), toolResults: [] });
    nextRunner.result.resolve({ output: "finished at the limit" });
    expect((await f.coordinator.result(null, next.id, { wait: true })).agent.status).toBe(
      "completed",
    );
    const failed = f.coordinator.spawn(owner, { prompt: "failure at limit" });
    const failedRunner = f.runners.get(failed.id)!;
    await failedRunner.started.promise;
    f.calls
      .get(failed.id)!
      .onEvent({ type: "turn_end", message: assistant("error"), toolResults: [] });
    failedRunner.result.resolve({ output: "", error: "provider unavailable" });
    expect((await f.coordinator.result(null, failed.id, { wait: true })).agent).toMatchObject({
      status: "failed",
      failure: { category: "unknown", phase: "model" },
    });
    await f.coordinator.close();
  });

  test("records usage and tool metadata without copying tool payloads or assistant prose", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    const options = f.calls.get(record.id)!;
    options.onEvent({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call",
      args: { secret: "private args" },
    });
    options.onEvent({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "call",
      isError: false,
      result: { private: "private result" },
    });
    options.onEvent({ type: "message_end", message: assistant() });
    runner.result.resolve({ output: "answer" });
    const result = await f.coordinator.result(null, record.id, { wait: true });
    expect(result.agent.usage).toEqual({
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite: 6,
      cost: 1,
    });
    expect(result.agent.toolUses).toBe(1);
    expect(JSON.stringify(f.diagnostics)).not.toContain("private");
    expect(f.diagnostics.some((event) => event.event === "model.completed")).toBe(true);
    await f.coordinator.close();
  });

  test("failed startup has an honest missing transcript and releases admission", async () => {
    const store = new FakeManifestStore();
    const coordinator = new SubagentCoordinator<undefined>({
      rootSessionId: "root",
      settings: SettingsSchema.parse({ maxActive: 1 }),
      store,
      toolsFor: () => [],
      async createRunner(options) {
        options.onDiagnostic("extension.failed", { category: "extension", phase: "startup" });
        throw new Error("The child could not load its configured extensions");
      },
    });
    const first = coordinator.spawn(owner, { prompt: "task" });
    const result = await coordinator.result(null, first.id, { wait: true });
    expect(result.agent).toMatchObject({
      status: "failed",
      transcriptPath: null,
      failure: { category: "extension", phase: "startup" },
    });
    const second = coordinator.spawn(owner, { prompt: "next" });
    await coordinator.result(null, second.id, { wait: true });
    await coordinator.close();
  });

  test("auth preflight rejection retains a controlled failure even without a conversation response", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    runner.result.reject(
      new Error(
        'Authentication failed for "fake". Credentials may have expired or network is unavailable. Run /login.',
      ),
    );
    const result = await f.coordinator.result(null, record.id, { wait: true });
    expect(result.agent).toMatchObject({
      status: "failed",
      failure: { category: "authentication", phase: "model", reason: "credentials_unavailable" },
    });
    expect(result.error).toContain("may have expired");
    expect(JSON.stringify(f.diagnostics)).not.toContain("may have expired");
    await f.coordinator.close();
  });

  test("bounds returned output while retaining complete metadata after result-cache eviction", async () => {
    const f = fixture();
    let firstId = "";
    for (let i = 0; i < 129; i++) {
      const record = f.coordinator.spawn(owner, { prompt: "task" });
      if (i === 0) firstId = record.id;
      const runner = f.runners.get(record.id)!;
      await runner.started.promise;
      runner.result.resolve({ output: i === 128 ? "x".repeat(65_000) : "answer" });
      const result = await f.coordinator.result(null, record.id, { wait: true });
      if (i === 128) {
        expect(result.output).toHaveLength(64_000);
        expect(result.agent).toMatchObject({ truncated: true, partial: true, status: "completed" });
      }
    }
    expect(f.coordinator.list(null)).toHaveLength(129);
    expect(f.store.records.size).toBe(129);
    expect(await f.coordinator.result(null, firstId)).toMatchObject({
      outputAvailable: false,
      agent: { transcriptPath: "/traces/native.jsonl" },
    });
    await f.coordinator.close();
  });

  test("observer failure cannot change execution and observations do not rewrite the manifest", async () => {
    const store = new FakeManifestStore();
    const runner = new FakeChildRunner();
    const update = vi.spyOn(store, "update");
    let options: ChildRunnerOptions<undefined> | undefined;
    const coordinator = new SubagentCoordinator<undefined>({
      rootSessionId: "root",
      settings: SettingsSchema.parse({}),
      store,
      toolsFor: () => [],
      async createRunner(input) {
        options = input;
        return runner;
      },
      onDiagnostic() {
        throw new Error("private observer failure");
      },
    });
    const record = coordinator.spawn(owner, { prompt: "task" });
    await runner.started.promise;
    const writes = update.mock.calls.length;
    options!.onEvent({ type: "message_end", message: assistant() });
    expect(update).toHaveBeenCalledTimes(writes);
    runner.result.resolve({ output: "answer" });
    expect((await coordinator.result(null, record.id, { wait: true })).agent.status).toBe(
      "completed",
    );
    await coordinator.close();
  });

  test("terminal manifest failure remains explicit without relabelling successful execution", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    f.store.failWrites = true;
    runner.result.resolve({ output: "completed answer" });
    const result = await f.coordinator.result(null, record.id, { wait: true });
    expect(result.agent).toMatchObject({
      status: "completed",
      persistenceFailure: { category: "persistence", phase: "persistence" },
    });
    expect(f.diagnostics.some((event) => event.event === "persistence.failed")).toBe(true);
    expect(f.diagnostics.some((event) => event.event === "agent.completed")).toBe(true);
    f.store.failWrites = false;
    // The last durable snapshot remains running after a failed terminal write.
    expect(f.store.records.get(record.id)?.status).toBe("running");
    await f.coordinator.close();
  });

  test("stopping while completed execution is disposing does not relabel it cancelled", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    const disposing = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    runner.close = async () => {
      cleanupStarted.resolve();
      await disposing.promise;
    };
    await runner.started.promise;
    runner.result.resolve({ output: "answer" });
    await cleanupStarted.promise;
    const stopping = f.coordinator.stop(null, record.id);
    disposing.resolve();
    expect((await stopping).status).toBe("completed");
    await f.coordinator.close();
  });

  test("cleanup failure is distinct from a completed task outcome", async () => {
    const f = fixture();
    const record = f.coordinator.spawn(owner, { prompt: "task" });
    const runner = f.runners.get(record.id)!;
    await runner.started.promise;
    runner.close = async () => {
      throw new Error("private cleanup error");
    };
    runner.result.resolve({ output: "answer" });
    expect((await f.coordinator.result(null, record.id, { wait: true })).agent).toMatchObject({
      status: "completed",
      cleanupFailure: { category: "cleanup", phase: "cleanup" },
    });
    expect(JSON.stringify(f.diagnostics)).not.toContain("private cleanup error");
    await f.coordinator.close();
  });
});
