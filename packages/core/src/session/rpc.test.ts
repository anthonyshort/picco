import { describe, expect, test, vi } from "vitest";
import { FakeRuntimeProcess } from "../testing/index.js";
import { RpcSession } from "./rpc.js";
import type { TurnEvent } from "./turn.js";

describe("RpcSession", () => {
  test("prompt resolves with the last assistant text", async () => {
    const proc = new FakeRuntimeProcess({ reply: (p) => `re: ${p}` });
    const session = new RpcSession("k", proc);
    expect(await session.prompt("hello")).toBe("re: hello");
  });

  test("empty reply falls back to '(no text response)'", async () => {
    const proc = new FakeRuntimeProcess({ reply: () => "" });
    const session = new RpcSession("k", proc);
    expect(await session.prompt("hello")).toBe("(no text response)");
  });

  test("forwards tool and text events to onEvent during the prompt", async () => {
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [
        { type: "tool_execution_start", toolName: "mcp__probe__echo", toolCallId: "c1" },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } },
        {
          type: "tool_execution_end",
          toolName: "mcp__probe__echo",
          toolCallId: "c1",
          isError: true,
        },
      ],
    });
    const session = new RpcSession("k", proc);
    const events: TurnEvent[] = [];
    await session.prompt("go", { onEvent: (e) => events.push(e) });

    expect(events).toEqual([
      { type: "tool_start", tool: "mcp__probe__echo", toolCallId: "c1" },
      { type: "text", text: "x" },
      { type: "tool_end", tool: "mcp__probe__echo", toolCallId: "c1", isError: true },
    ]);
  });

  test("waits for agent_settled after an agent_end recovery boundary", async () => {
    const reply = Promise.withResolvers<string>();
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [{ type: "agent_end" }],
      reply: () => reply.promise,
    });
    const session = new RpcSession("k", proc);
    const result = session.prompt("go");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(proc.requests.map((request) => request.type)).toEqual(["prompt"]);
    reply.resolve("recovered reply");
    expect(await result).toBe("recovered reply");
  });

  test("handled extension commands return without waiting for an agent run", async () => {
    const proc = new FakeRuntimeProcess({ handlePrompt: true });
    const session = new RpcSession("k", proc);
    expect(await session.prompt("/mcp reconnect probe", { timeoutMs: 100 })).toBe("");
    expect(proc.requests.map((request) => request.type)).toEqual(["prompt", "get_state"]);
    expect(await session.prompt("/mcp", { timeoutMs: 100 })).toBe("");
  });

  test("handled session replacement refreshes native identity before the next request", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    let sessionId = "old";
    const proc = new FakeRuntimeProcess({
      handlePrompt: true,
      state: () => ({ sessionId, sessionFile: `/sessions/${sessionId}.jsonl` }),
    });
    const session = new RpcSession("k", proc, { logger });
    await session.refreshState();
    sessionId = "new";
    const command = session.prompt("/fresh");
    proc.push({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "headless-subagents:event",
        data: {
          version: 1,
          at: "2026-10-24T14:20:00.000Z",
          rootSessionId: "new",
          executionId: "new-execution",
          agentId: "child",
          parentAgentId: null,
          event: "agent.created",
          data: {},
        },
      },
    });
    await command;
    const child = logger.log.mock.calls.find(([event]) => event === "agent.created")![1];
    expect(child).toMatchObject({ rootSessionId: "new" });
    expect(child).not.toHaveProperty("piSessionId");
    expect(child).not.toHaveProperty("rootTranscriptPath");
    await session.prompt("next", { requestId: "next-request" });
    expect(logger.log).toHaveBeenCalledWith(
      "request.started",
      expect.objectContaining({
        requestId: "next-request",
        piSessionId: "new",
        transcriptPath: "/sessions/new.jsonl",
      }),
    );
    await session.kill();
  });

  test("final text RPC deadline retains the known timeout and command", async () => {
    vi.useFakeTimers();
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const proc = new FakeRuntimeProcess({ neverReturnText: true });
    const session = new RpcSession("k", proc, { logger, requestTimeoutMs: 100 });
    try {
      const result = expect(session.prompt("go", { requestId: "request1" })).rejects.toThrow(
        "get_last_assistant_text timed out after 0.1s",
      );
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(logger.error).toHaveBeenCalledWith(
        "request.failed",
        expect.objectContaining({
          requestId: "request1",
          category: "timeout",
          phase: "protocol",
          rpcCommand: "get_last_assistant_text",
        }),
      );
      expect(logger.log).toHaveBeenCalledWith(
        "request.finished",
        expect.objectContaining({ outcome: "timed_out" }),
      );
    } finally {
      await session.kill();
      vi.useRealTimers();
    }
  });

  test.each(["select", "confirm", "input", "editor"])(
    "cancels extension %s dialogs so headless prompts can finish",
    async (method) => {
      const proc = new FakeRuntimeProcess({
        eventsFor: () => [
          { type: "extension_ui_request", method, id: "dialog", title: "Continue?" },
        ],
      });
      const session = new RpcSession("k", proc);
      await session.prompt("go");
      expect(proc.requests).toContainEqual({
        type: "extension_ui_response",
        id: "dialog",
        cancelled: true,
      });
    },
  );

  test("overlapping prompts are rejected", async () => {
    const proc = new FakeRuntimeProcess({ neverFinish: true });
    const session = new RpcSession("k", proc);
    const first = session.prompt("a", { timeoutMs: 200 });
    await new Promise((r) => setTimeout(r, 10));
    await expect(session.prompt("b")).rejects.toThrow("already has a prompt in flight");
    session.abortTurn();
    await first.catch(() => {});
  });

  test("prompt times out, aborts the turn, and rejects", async () => {
    const proc = new FakeRuntimeProcess({ neverFinish: true });
    const session = new RpcSession("k", proc);
    await expect(session.prompt("x", { timeoutMs: 20 })).rejects.toThrow("timed out");
    // The timeout fires an abort so the next prompt can't overlap the runaway turn.
    expect(proc.prompts).toEqual(["x"]);
    expect(session.isAlive()).toBe(true);
  });

  test("process death rejects the in-flight prompt and marks the session dead", async () => {
    const proc = new FakeRuntimeProcess({ dieOnPrompt: true });
    const session = new RpcSession("k", proc);
    await expect(session.prompt("boom")).rejects.toThrow("pi process exited");
    expect(session.isAlive()).toBe(false);
    await expect(session.prompt("again")).rejects.toThrow("is dead");
  });

  test("keeps a stderr tail for diagnostics", async () => {
    const proc = new FakeRuntimeProcess();
    const session = new RpcSession("k", proc);
    proc.pushStderr("warning: something odd");
    await new Promise((r) => setTimeout(r, 10));
    expect(session.stderrTail()).toContain("something odd");
  });

  test("stats returns token usage; null on failure", async () => {
    const proc = new FakeRuntimeProcess({ tokens: 42 });
    const session = new RpcSession("k", proc);
    expect(await session.stats()).toBe(42);

    const dead = new FakeRuntimeProcess({ exitOnSpawn: { code: 1 } });
    const deadSession = new RpcSession("k2", dead);
    await new Promise((r) => setTimeout(r, 10));
    expect(await deadSession.stats()).toBeNull();
  });
  test("RPC auth preflight classification survives public Error wrapping", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const source =
      'Authentication failed for "fixture". Credentials may have expired or network is unavailable. Run /login.';
    const session = new RpcSession("k", new FakeRuntimeProcess({ promptError: source }), {
      logger,
    });
    await expect(session.prompt("private task", { requestId: "request1" })).rejects.toThrow(
      `prompt failed: ${source}`,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "request.failed",
      expect.objectContaining({
        requestId: "request1",
        category: "authentication",
        reason: "credentials_unavailable",
      }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(source);
    await session.kill();
  });

  test("output limits remain visible while preserving partial text", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const session = new RpcSession(
      "k",
      new FakeRuntimeProcess({
        reply: () => "partial",
        eventsFor: () => [
          { type: "message_end", message: { role: "assistant", stopReason: "length" } },
        ],
      }),
      { logger },
    );
    expect(await session.prompt("go")).toBe("partial");
    expect(logger.warning).toHaveBeenCalledWith(
      "model.output_limited",
      expect.objectContaining({ category: "output_limit" }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "request.finished",
      expect.objectContaining({ outcome: "output_limited" }),
    );
    await session.kill();
  });

  test("model auth errors retain selected evidence and never forward provider text", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "openai",
            model: "fixture",
            stopReason: "error",
            errorMessage: "private prompt and Bearer private-token",
            diagnostics: [
              {
                error: { code: 401, message: "private provider response", stack: "private stack" },
                details: { token: "private-token" },
              },
            ],
          },
        },
      ],
    });
    const session = new RpcSession("chat", proc, { logger, workerId: "worker1" });
    await session.refreshState();
    await session.prompt("private task", { requestId: "request1" });
    expect(logger.error).toHaveBeenCalledWith("model.failed", {
      key: "chat",
      workerId: "worker1",
      requestId: "request1",
      piSessionId: "fake-pi-session",
      transcriptPath: "/fake/transcript.jsonl",
      provider: "openai",
      model: "fixture",
      category: "authentication",
      phase: "model",
      statusCode: 401,
      reason: "authentication_rejected",
    });
    expect(logger.log).toHaveBeenCalledWith(
      "request.finished",
      expect.objectContaining({ requestId: "request1", outcome: "model_failed" }),
    );
    expect(JSON.stringify([logger.log.mock.calls, logger.error.mock.calls])).not.toContain(
      "private",
    );
    await session.kill();
  });

  test.each([true, false])(
    "retry success=%s is separate from the enclosing request",
    async (success) => {
      const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
      const proc = new FakeRuntimeProcess({
        eventsFor: () => [
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
            errorMessage: "HTTP 429: private text",
          },
          { type: "auto_retry_end", success, attempt: 2, finalError: "HTTP 429: private text" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: success ? "stop" : "error",
              errorMessage: success ? undefined : "HTTP 429: private text",
            },
          },
        ],
      });
      const session = new RpcSession("k", proc, { logger });
      await session.prompt("go", { requestId: "request1" });
      expect(logger.warning).toHaveBeenCalledWith(
        "model.retry_scheduled",
        expect.objectContaining({
          requestId: "request1",
          category: "rate_limit",
          attempt: 1,
          delayMs: 2000,
        }),
      );
      expect(success ? logger.log : logger.error).toHaveBeenCalledWith(
        success ? "model.recovered" : "model.retries_exhausted",
        expect.objectContaining({ attempt: 2 }),
      );
      expect(logger.log).toHaveBeenCalledWith(
        "request.finished",
        expect.objectContaining({ outcome: success ? "completed" : "model_failed" }),
      );
      expect(JSON.stringify([logger.log.mock.calls, logger.error.mock.calls])).not.toContain(
        "private",
      );
      await session.kill();
    },
  );

  test.each([
    "idle_eviction",
    "reset",
    "one_shot_completed",
    "host_shutdown",
    "turn_failed",
    "timeout",
    "cancelled",
  ] as const)("requested %s termination records its cause and process facts", async (reason) => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const proc = new FakeRuntimeProcess();
    const session = new RpcSession("k", proc, { logger, workerId: "worker1" });
    await session.kill(reason);
    expect(logger.log).toHaveBeenCalledWith("worker.stop_requested", {
      key: "k",
      workerId: "worker1",
      reason,
      inFlight: false,
    });
    expect(logger.log).toHaveBeenCalledWith("worker.exited", {
      key: "k",
      workerId: "worker1",
      exitCode: null,
      signal: "SIGTERM",
      expected: true,
      stopReason: reason,
      inFlight: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each([
    [137, false],
    [143, true],
  ] as const)(
    "requested shutdown preserves exit %s without guessing its cause",
    async (exitCode, expected) => {
      const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
      const proc = new FakeRuntimeProcess();
      const session = new RpcSession(
        "k",
        {
          stdin: proc.stdin,
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: proc.exited,
          get alive() {
            return proc.alive;
          },
          async kill() {
            proc.die(exitCode);
          },
        },
        { logger },
      );
      await session.kill("host_shutdown");
      expect(expected ? logger.log : logger.error).toHaveBeenCalledWith(
        "worker.exited",
        expect.objectContaining({ exitCode, signal: null, expected, stopReason: "host_shutdown" }),
      );
    },
  );

  test.each(["SIGTERM", "failure_before_cleanup", "failure_during_cleanup"])(
    "%s remains an unexpected exit",
    async (mode) => {
      const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
      const proc = new FakeRuntimeProcess();
      const session = new RpcSession(
        "k",
        mode === "failure_during_cleanup"
          ? {
              stdin: proc.stdin,
              stdout: proc.stdout,
              stderr: proc.stderr,
              exited: proc.exited,
              get alive() {
                return proc.alive;
              },
              async kill() {
                proc.die(1);
              },
            }
          : proc,
        { logger },
      );
      if (mode !== "failure_during_cleanup")
        proc.die(mode === "SIGTERM" ? null : 1, mode === "SIGTERM" ? "SIGTERM" : null);
      await session.kill();
      expect(logger.error).toHaveBeenCalledWith(
        "worker.exited",
        expect.objectContaining({ expected: false, exitCode: mode === "SIGTERM" ? null : 1 }),
      );
    },
  );

  test("runtime monitor failure remains distinct from an observed process exit", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const failed = Promise.withResolvers<{ code: number | null; signal: string | null }>();
    const proc = new FakeRuntimeProcess();
    const session = new RpcSession(
      "k",
      {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: failed.promise,
        get alive() {
          return proc.alive;
        },
        kill: () => proc.kill(),
      },
      { logger },
    );
    const result = expect(session.prompt("go")).rejects.toThrow("Worker process error");
    failed.reject(new Error("private monitor detail"));
    await result;
    expect(logger.error).toHaveBeenCalledWith(
      "worker.failed",
      expect.objectContaining({ category: "runtime", phase: "model", expected: false }),
    );
    expect(logger.error).not.toHaveBeenCalledWith("worker.exited", expect.anything());
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private");
    await session.kill();
  });

  test("progress and tool duration are metadata only; completion clears timers", async () => {
    vi.useFakeTimers();
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const reply = Promise.withResolvers<string>();
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [{ type: "tool_execution_start", toolName: "probe", toolCallId: "c1" }],
      reply: () => reply.promise,
    });
    const session = new RpcSession("k", proc, { logger });
    try {
      const result = session.prompt("private prompt", { requestId: "request1" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.log).toHaveBeenCalledWith(
        "request.progress",
        expect.objectContaining({ requestId: "request1", durationMs: 30_000, activeTools: 1 }),
      );
      proc.push({
        type: "tool_execution_end",
        toolName: "probe",
        toolCallId: "c1",
        isError: true,
        result: { text: "private output" },
      });
      reply.resolve("private answer");
      await result;
      expect(logger.warning).toHaveBeenCalledWith(
        "tool.finished",
        expect.objectContaining({ tool: "probe", outcome: "failed", durationMs: 30_000 }),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify([logger.log.mock.calls, logger.warning.mock.calls])).not.toContain(
        "private",
      );
    } finally {
      await session.kill();
      vi.useRealTimers();
    }
  });

  test.each(["timeout", "death", "abort"])("progress timers stop after %s", async (mode) => {
    vi.useFakeTimers();
    const proc = new FakeRuntimeProcess({ neverFinish: true });
    const session = new RpcSession("k", proc);
    try {
      const result = session.prompt("go", { timeoutMs: 45_000 });
      const settled =
        mode === "abort" ? expect(result).resolves.toBeDefined() : expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);
      if (mode === "death") proc.die(1);
      else if (mode === "abort") session.abortTurn();
      else await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await session.kill();
      vi.useRealTimers();
    }
  });

  test("background child origin remains attached to its creation request", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const reply = Promise.withResolvers<string>();
    const proc = new FakeRuntimeProcess({
      reply: (prompt) => (prompt === "second" ? reply.promise : "started"),
    });
    const session = new RpcSession("k", proc, { logger });
    const event = (name: string, agentId: string, parentAgentId: string | null) => ({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "headless-subagents:event",
        data: {
          version: 1,
          at: "2026-10-24T14:20:00.000Z",
          rootSessionId: "root",
          executionId: "execution1",
          agentId,
          parentAgentId,
          event: name,
          data: {},
        },
      },
    });
    const first = session.prompt("first", { requestId: "request1" });
    proc.push(event("agent.created", "child", null));
    await first;
    const second = session.prompt("second", { requestId: "request2" });
    proc.push(event("agent.created", "grandchild", "child"));
    proc.push(event("agent.completed", "grandchild", "child"));
    proc.push(event("agent.completed", "unobserved-child", null));
    reply.resolve("done");
    await second;
    expect(logger.log).toHaveBeenCalledWith(
      "agent.completed",
      expect.objectContaining({
        agentId: "grandchild",
        parentAgentId: "child",
        requestId: "request1",
      }),
    );
    expect(
      logger.log.mock.calls.find(
        ([name, data]) => name === "agent.completed" && data.agentId === "unobserved-child",
      )![1],
    ).not.toHaveProperty("requestId");
    await session.kill();
  });

  test("extension/protocol/stderr content is not copied to operational events", async () => {
    const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [
        { type: "extension_error", error: "private token", event: "private hook" },
        { type: "extension_ui_request", method: "notify", message: "private notification" },
        { type: "parse_error", error: "private malformed frame" },
      ],
    });
    const session = new RpcSession("k", proc, { logger });
    proc.pushStderr("private stderr");
    await session.prompt("go");
    expect(logger.error).toHaveBeenCalledWith(
      "extension.failed",
      expect.objectContaining({ category: "extension" }),
    );
    expect(logger.warning).toHaveBeenCalledWith(
      "worker.protocol_failed",
      expect.objectContaining({ category: "protocol" }),
    );
    expect(
      JSON.stringify([logger.log.mock.calls, logger.warning.mock.calls, logger.error.mock.calls]),
    ).not.toContain("private");
    await session.kill();
  });

  test.each(["completed", "cancelled", "failed"])(
    "compaction %s has a controlled outcome",
    async (outcome) => {
      const logger = { log: vi.fn(), warning: vi.fn(), error: vi.fn() };
      const proc = new FakeRuntimeProcess({
        eventsFor: () => [
          { type: "compaction_start" },
          {
            type: "compaction_end",
            aborted: outcome === "cancelled",
            errorMessage: outcome === "failed" ? "HTTP 503: private response" : undefined,
            result: { summary: "private summary" },
          },
        ],
      });
      const session = new RpcSession("k", proc, { logger });
      await session.prompt("go");
      expect(outcome === "failed" ? logger.error : logger.log).toHaveBeenCalledWith(
        "compaction.finished",
        expect.objectContaining({ outcome, durationMs: expect.any(Number) }),
      );
      expect(JSON.stringify([logger.log.mock.calls, logger.error.mock.calls])).not.toContain(
        "private",
      );
      await session.kill();
    },
  );
});
