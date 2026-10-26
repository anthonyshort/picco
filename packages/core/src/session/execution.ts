import type { SessionRef } from "../types.js";

/**
 * Trusted identity for one submitted prompt, independent of its conversation lifetime.
 */
export interface ExecutionRef {
  id: string;
  session: SessionRef;
}

/**
 * Model work outcome passed to critical finalisers before the caller settles.
 */
export interface ExecutionOutcome {
  status: "success" | "error" | "cancelled" | "timeout";
  error?: Error;
}

/**
 * Critical cleanup context. A deadline aborts signal; uncertain ownership must remain fenced.
 */
export interface ExecutionFinalisation {
  execution: ExecutionRef;
  outcome: ExecutionOutcome;
  signal: AbortSignal;
}

/**
 * Stable technical failure category with a safe caller-facing message.
 */
export class ExecutionError extends Error {
  constructor(
    readonly code: "cancelled" | "timeout" | "provider" | "worker",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

/**
 * Preserve the execution's original cause together with every critical cleanup failure.
 */
export class ExecutionFailure extends AggregateError {
  constructor(
    readonly execution: ExecutionRef,
    readonly primary: Error | undefined,
    readonly finalisationErrors: Error[],
  ) {
    super(
      [...(primary ? [primary] : []), ...finalisationErrors],
      primary?.message ?? "Execution finalisation failed",
      { cause: primary ?? finalisationErrors[0] },
    );
    this.name = "ExecutionFailure";
  }
}

/**
 * Await bounded critical work without hiding a timed-out operation's eventual rejection.
 */
export async function finaliseWithin(
  operation: (signal: AbortSignal) => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => operation(abort.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort(new Error("Execution finalisation timed out"));
          reject(abort.signal.reason);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
