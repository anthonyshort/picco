import type { Logger } from "../types.js";
import type { ExecutionRef } from "./execution.js";

/**
 * Unbuffered worker events available to execution observers.
 */
export type WorkerEvent =
  | { type: "agent_start" }
  | { type: "agent_settled" }
  | { type: "tool_start"; tool: string; toolCallId: string; args: unknown }
  | { type: "tool_end"; tool: string; toolCallId: string; isError: boolean; result: unknown }
  | { type: "custom_message"; customType: string; details: unknown };

/**
 * Work that must finish before its execution loses tool authority.
 */
export interface ExecutionHold {
  /**
   * Finish work; after next-settlement also awaits the continuation following this call.
   */
  complete(options?: { after: "next-settlement" }): void;
  fail(error: Error): void;
}

/**
 * Execution identity and cancellation shared with synchronous observers.
 */
export interface ExecutionObservation {
  execution: ExecutionRef;
  signal: AbortSignal;
  /**
   * Register immediately. Retire detached workers and revoke their token before the queue advances;
   * persisted conversation history remains available for the replacement worker.
   */
  hold(options: { name: string; retireWorker?: boolean }): ExecutionHold;
}

/**
 * Observe transport events synchronously; never await work in this callback.
 */
export interface ExecutionObserver {
  onEvent(event: WorkerEvent): void;
}

/**
 * Creates an observer before an execution sends its prompt.
 */
export type ExecutionObserverFactory = (ctx: ExecutionObservation) => ExecutionObserver | void;

/**
 * Tracks holds and worker settlement for one execution, without retaining result payloads.
 */
export class ExecutionWork {
  private readonly holds = new Set<object>();
  private readonly observers: ExecutionObserver[] = [];
  private settled = false;
  private sequence = 0;
  private requiredSettlement = 0;
  private lastSettlement = 0;
  private active = true;
  private failure?: Error;
  retireWorker = false;
  version = 0;
  onChange?: () => void;

  constructor(
    execution: ExecutionRef,
    signal: AbortSignal,
    factories: ExecutionObserverFactory[],
    logger?: Logger,
  ) {
    const ctx: ExecutionObservation = {
      execution,
      signal,
      hold: ({ name, retireWorker }) => {
        if (!this.active || signal.aborted) throw new Error("Execution is no longer running");
        const token = {};
        this.holds.add(token);
        this.retireWorker ||= Boolean(retireWorker);
        logger?.log("execution hold started", {
          executionId: execution.id,
          name,
          pending: this.holds.size,
        });
        this.changed();
        return {
          complete: (options) => {
            if (!this.active || !this.holds.delete(token)) return;
            if (options?.after === "next-settlement") {
              this.requiredSettlement = this.sequence + 1;
            }
            logger?.log("execution hold completed", {
              executionId: execution.id,
              name,
              pending: this.holds.size,
              after: options?.after,
            });
            this.changed();
          },
          fail: (error) => {
            if (!this.active || !this.holds.delete(token)) return;
            logger?.log("execution hold failed", {
              executionId: execution.id,
              name,
              pending: this.holds.size,
            });
            this.failure = error;
            this.changed();
          },
        };
      },
    };
    for (const factory of factories) {
      const observer = factory(ctx);
      if (observer) this.observers.push(observer);
    }
  }

  /**
   * True only after all work and its required worker settlement have completed.
   */
  ready(): boolean {
    if (this.failure) throw this.failure;
    return this.settled && this.holds.size === 0 && this.lastSettlement >= this.requiredSettlement;
  }

  /**
   * Process observers before allowing this event to settle the execution.
   */
  emit(event: WorkerEvent): void {
    if (!this.active) return;
    this.sequence++;
    if (event.type === "agent_start") this.settled = false;
    if (event.type === "agent_settled") {
      this.settled = true;
      this.lastSettlement = this.sequence;
    }
    for (const observer of this.observers) observer.onEvent(event);
    this.changed();
  }

  /**
   * Reject further registration and forget all execution-owned observers.
   */
  close(): void {
    this.active = false;
    this.holds.clear();
    this.observers.length = 0;
    this.onChange = undefined;
  }

  private changed(): void {
    this.version++;
    this.onChange?.();
  }
}
