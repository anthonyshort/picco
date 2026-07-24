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
        { type: "tool_execution_start", toolName: "bash", toolCallId: "c1" },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } },
        { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: true },
      ],
    });
    const session = new RpcSession("k", proc);
    const events: TurnEvent[] = [];
    await session.prompt("go", { onEvent: (e) => events.push(e) });

    expect(events).toEqual([
      { type: "tool_start", tool: "bash", toolCallId: "c1" },
      { type: "text", text: "x" },
      { type: "tool_end", tool: "bash", toolCallId: "c1", isError: true },
    ]);
  });

  test("mcp-adapter proxy calls surface the real tool name from args.tool", async () => {
    const proc = new FakeRuntimeProcess({
      eventsFor: () => [
        // Bridge tool via the adapter's proxy tool: real name is in args.
        {
          type: "tool_execution_start",
          toolName: "mcp",
          toolCallId: "c1",
          args: { tool: "reply" },
        },
        // The end event carries no args — the name is remembered by call id.
        { type: "tool_execution_end", toolName: "mcp", toolCallId: "c1", isError: false },
        // A proxy management call (search/connect) has no args.tool: stays "mcp".
        { type: "tool_execution_start", toolName: "mcp", toolCallId: "c2", args: { search: "x" } },
        { type: "tool_execution_end", toolName: "mcp", toolCallId: "c2", isError: false },
      ],
    });
    const session = new RpcSession("k", proc);
    const events: TurnEvent[] = [];
    await session.prompt("go", { onEvent: (e) => events.push(e) });

    expect(events).toEqual([
      { type: "tool_start", tool: "reply", toolCallId: "c1" },
      { type: "tool_end", tool: "reply", toolCallId: "c1", isError: false },
      { type: "tool_start", tool: "mcp", toolCallId: "c2" },
      { type: "tool_end", tool: "mcp", toolCallId: "c2", isError: false },
    ]);
  });

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
