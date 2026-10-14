import { describe, expect, test } from "vitest";
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
});
