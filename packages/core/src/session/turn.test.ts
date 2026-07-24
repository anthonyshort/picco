import { describe, expect, test } from "vitest";
import { createTurn, type TurnEvent } from "./turn.js";

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("Turn", () => {
  test("is awaitable and resolves to the TurnResult", async () => {
    const { turn, resolve } = createTurn();
    resolve({ text: "hi", durationMs: 5 });
    expect(turn).toBeInstanceOf(Promise);
    await expect(turn).resolves.toEqual({ text: "hi", durationMs: 5 });
  });

  test("rejection propagates to await", async () => {
    const { turn, reject } = createTurn();
    reject(new Error("session crashed"));
    await expect(turn).rejects.toThrow("session crashed");
  });

  test("events stream live to a consumer", async () => {
    const { turn, emit, resolve } = createTurn();
    const collected = collect(turn.events);

    emit({ type: "turn_start" });
    emit({ type: "tool_start", tool: "read", toolCallId: "t1" });
    emit({ type: "tool_end", tool: "read", toolCallId: "t1", isError: false });
    emit({ type: "turn_end" });
    resolve({ text: "done", durationMs: 10 });

    expect(await collected).toEqual([
      { type: "turn_start" },
      { type: "tool_start", tool: "read", toolCallId: "t1" },
      { type: "tool_end", tool: "read", toolCallId: "t1", isError: false },
      { type: "turn_end" },
    ]);
  });

  test("multiple consumers each see the full stream", async () => {
    const { turn, emit, resolve } = createTurn();

    const first = collect(turn.events);
    emit({ type: "turn_start" });
    // Second consumer starts after events were already emitted — replays.
    const second = collect(turn.events);
    emit({ type: "turn_end" });
    resolve({ text: "done", durationMs: 1 });

    const expected: TurnEvent[] = [{ type: "turn_start" }, { type: "turn_end" }];
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
  });

  test("a consumer starting after settlement replays everything, then ends", async () => {
    const { turn, emit, resolve } = createTurn();
    emit({ type: "turn_start" });
    emit({ type: "turn_end" });
    resolve({ text: "done", durationMs: 1 });
    await turn;

    expect(await collect(turn.events)).toEqual([{ type: "turn_start" }, { type: "turn_end" }]);
  });

  test("event stream ends on rejection too", async () => {
    const { turn, emit, reject } = createTurn();
    turn.catch(() => {}); // observed elsewhere in this test
    const collected = collect(turn.events);
    emit({ type: "turn_start" });
    reject(new Error("boom"));

    expect(await collected).toEqual([{ type: "turn_start" }]);
    await expect(turn).rejects.toThrow("boom");
  });

  test("abort() invokes the onAbort hook with the reason", () => {
    const aborts: (string | undefined)[] = [];
    const { turn } = createTurn({ onAbort: (reason) => aborts.push(reason) });
    turn.abort("user cancelled");
    expect(aborts).toEqual(["user cancelled"]);
  });

  test("settling twice is a no-op", async () => {
    const { turn, resolve, reject } = createTurn();
    resolve({ text: "first", durationMs: 1 });
    reject(new Error("late"));
    resolve({ text: "second", durationMs: 2 });
    await expect(turn).resolves.toEqual({ text: "first", durationMs: 1 });
  });

  test("events emitted after settlement are dropped", async () => {
    const { turn, emit, resolve } = createTurn();
    emit({ type: "turn_start" });
    resolve({ text: "done", durationMs: 1 });
    emit({ type: "turn_end" });
    await turn;
    expect(await collect(turn.events)).toEqual([{ type: "turn_start" }]);
  });

  test("a slow consumer does not block a fast one", async () => {
    const { turn, emit, resolve } = createTurn();

    const fast = collect(turn.events);
    // Slow consumer: pull one event, then abandon the iterator.
    const slowIterator = turn.events[Symbol.asyncIterator]();

    emit({ type: "turn_start" });
    expect((await slowIterator.next()).value).toEqual({ type: "turn_start" });

    emit({ type: "turn_end" });
    resolve({ text: "done", durationMs: 1 });

    expect(await fast).toEqual([{ type: "turn_start" }, { type: "turn_end" }]);
  });
});
