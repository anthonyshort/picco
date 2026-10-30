import { ExecutionWork, type ExecutionHold } from "./work.js";
import { describe, expect, test } from "vitest";
import { FakeRuntimeProcess } from "../testing/index.js";
import { RpcSession } from "./rpc.js";
import type { TurnEvent } from "./turn.js";

describe("RpcSession", () => {
  describe("execution holds", () => {
    test("keeps the prompt open through a background completion and continuation", async () => {
      let hold!: ExecutionHold;
      const firstSettlement = Promise.withResolvers<void>();
      const work = new ExecutionWork(
        { id: "one", session: { source: "test", key: "k" } },
        new AbortController().signal,
        [
          (ctx) => {
            hold = ctx.hold({ name: "workflow" });
            return {
              onEvent(event) {
                if (event.type === "agent_settled") firstSettlement.resolve();
              },
            };
          },
        ],
      );
      const proc = new FakeRuntimeProcess({ reply: () => "final reply" });
      const session = new RpcSession("k", proc);
      const result = session.prompt("go", { work, timeoutMs: 1000 });
      await firstSettlement.promise;
      expect(proc.requests.map((request) => request.type)).toEqual(["prompt"]);
      hold.complete({ after: "next-settlement" });
      proc.push({ type: "agent_start" });
      proc.push({ type: "agent_settled" });
      expect(await result).toBe("final reply");
      work.close();
      await session.kill();
    });

    test("retrieves final text again when a continuation settles during retrieval", async () => {
      const retrieving = Promise.withResolvers<void>();
      const initialText = Promise.withResolvers<string>();
      let reads = 0;
      const proc = new FakeRuntimeProcess({
        lastAssistantText: () => {
          if (reads++ === 0) {
            retrieving.resolve();
            return initialText.promise;
          }
          return "final continuation";
        },
      });
      const work = new ExecutionWork(
        { id: "one", session: { source: "test", key: "k" } },
        new AbortController().signal,
        [],
      );
      const session = new RpcSession("k", proc);
      const result = session.prompt("go", { work, timeoutMs: 1000 });
      await retrieving.promise;
      proc.push({ type: "agent_start" });
      proc.push({ type: "agent_settled" });
      initialText.resolve("stale reply");
      expect(await result).toBe("final continuation");
      expect(reads).toBe(2);
      work.close();
      await session.kill();
    });

    test("retains the deadline while retrieving final text", async () => {
      const work = new ExecutionWork(
        { id: "one", session: { source: "test", key: "k" } },
        new AbortController().signal,
        [],
      );
      const proc = new FakeRuntimeProcess({
        lastAssistantText: () => {
          proc.push({ type: "agent_start" });
          proc.push({ type: "agent_settled" });
          return new Promise(() => {});
        },
      });
      const session = new RpcSession("k", proc);
      await expect(session.prompt("go", { work, timeoutMs: 20 })).rejects.toThrow("timed out");
      work.close();
      await session.kill();
    });

    test("keeps the original deadline while waiting for background work", async () => {
      const work = new ExecutionWork(
        { id: "one", session: { source: "test", key: "k" } },
        new AbortController().signal,
        [
          (ctx) => {
            ctx.hold({ name: "never" });
          },
        ],
      );
      const proc = new FakeRuntimeProcess();
      const session = new RpcSession("k", proc);
      await expect(session.prompt("go", { work, timeoutMs: 20 })).rejects.toThrow("timed out");
      work.close();
      await session.kill();
    });

    test("fails when an observer throws", async () => {
      const work = new ExecutionWork(
        { id: "one", session: { source: "test", key: "k" } },
        new AbortController().signal,
        [
          () => ({
            onEvent() {
              throw new Error("observer failed");
            },
          }),
        ],
      );
      const session = new RpcSession("k", new FakeRuntimeProcess());
      await expect(session.prompt("go", { work, timeoutMs: 1000 })).rejects.toThrow(
        "observer failed",
      );
      work.close();
      await session.kill();
    });
  });

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
    expect(proc.requests.map((request) => request.type)).toEqual(["prompt"]);
    expect(await session.prompt("/mcp", { timeoutMs: 100 })).toBe("");
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
  test("rejects provider failure and abort instead of returning stale assistant text", async () => {
    for (const stopReason of ["error", "aborted"]) {
      const proc = new FakeRuntimeProcess({
        reply: () => "stale text",
        eventsFor: () => [
          {
            type: "message_end",
            message: { role: "assistant", stopReason, errorMessage: "secret provider payload" },
          },
        ],
      });
      const rpc = new RpcSession("failure", proc);
      await expect(rpc.prompt("hi")).rejects.toThrow(
        stopReason === "error" ? "provider request failed" : "aborted",
      );
      expect(proc.requests.some((request) => request.type === "get_last_assistant_text")).toBe(
        false,
      );
      await proc.kill();
    }
  });

  test("a recovered provider attempt can still complete successfully", async () => {
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [
        { type: "message_end", message: { role: "assistant", stopReason: "error" } },
        { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
      ],
    });
    expect(await new RpcSession("recovered", proc).prompt("hello")).toBe("echo: hello");
    await proc.kill();
  });

  test("reload uses the registered command without a model prompt", async () => {
    const proc = new FakeRuntimeProcess();
    await new RpcSession("reload", proc).reload();
    expect(proc.requests.map((request) => request.type)).toEqual(["get_commands", "prompt"]);
    expect(proc.prompts).toEqual(["/picco-reload"]);
    await proc.kill();
  });
});
