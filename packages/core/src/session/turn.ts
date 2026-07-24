/**
 * The outcome of a completed turn.
 */
export interface TurnResult {
  /**
   * Final assistant message.
   */
  text: string;
  /**
   * Wall-clock duration of the turn, in milliseconds.
   */
  durationMs: number;
}

/**
 * A live event emitted while a turn runs — bracketed by turn_start/turn_end, with tool activity and
 * streamed assistant text in between.
 */
export type TurnEvent =
  | { type: "turn_start" }
  | { type: "text"; text: string }
  | { type: "tool_start"; tool: string; toolCallId: string }
  | { type: "tool_end"; tool: string; toolCallId: string; isError: boolean }
  | { type: "turn_end" };

/**
 * The value returned by every prompt-running API. It IS a native Promise for the {@link TurnResult}
 * (awaitable), carries a live {@link TurnEvent} stream, and is abortable. `events` is safe to ignore
 * and safe to iterate from multiple consumers — each sees the full stream from the start.
 */
export interface Turn extends Promise<TurnResult> {
  events: AsyncIterable<TurnEvent>;
  abort(reason?: string): void;
}

/**
 * The driver side of a Turn, held by the runtime: emit events and settle it. Created together with
 * its Turn by {@link createTurn}.
 */
export interface TurnController {
  turn: Turn;
  /**
   * Emit a live event to every events consumer.
   */
  emit(event: TurnEvent): void;
  /**
   * Resolve the turn. Ends the event stream.
   */
  resolve(result: TurnResult): void;
  /**
   * Reject the turn. Ends the event stream.
   */
  reject(err: Error): void;
}

/**
 * Create a Turn plus the controller that drives it. The controller stays with the runtime; the Turn
 * goes to the caller.
 */
export function createTurn(opts?: { onAbort?: (reason?: string) => void }): TurnController {
  const buffer = new EventBuffer();
  const { promise, resolve, reject } = Promise.withResolvers<TurnResult>();

  const turn: Turn = Object.assign(promise, {
    events: { [Symbol.asyncIterator]: () => buffer.iterate() },
    abort: (reason?: string) => opts?.onAbort?.(reason),
  });

  let settled = false;
  return {
    turn,
    emit: (event) => buffer.push(event),
    resolve: (result) => {
      if (settled) return;
      settled = true;
      buffer.end();
      resolve(result);
    },
    reject: (err) => {
      if (settled) return;
      settled = true;
      buffer.end();
      reject(err);
    },
  };
}

/**
 * Buffers every event so late (or slow) consumers replay the full stream, then follow live. `end()`
 * lets iterators complete; events after `end()` are dropped.
 */
class EventBuffer {
  private readonly events: TurnEvent[] = [];
  private ended = false;
  private wakeWaiters: (() => void)[] = [];

  push(event: TurnEvent): void {
    if (this.ended) return;
    this.events.push(event);
    this.wake();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  /**
   * Replay-from-start iterator that then follows the live stream.
   */
  async *iterate(): AsyncGenerator<TurnEvent, void, undefined> {
    let index = 0;
    while (true) {
      while (index < this.events.length) yield this.events[index++]!;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.wakeWaiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const wake of waiters) wake();
  }
}
