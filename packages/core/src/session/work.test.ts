import { describe, expect, it } from "vitest";
import { ExecutionWork, type ExecutionHold } from "./work.js";

const execution = { id: "execution-1", session: { source: "test", key: "one" } };

describe("ExecutionWork", () => {
  describe("settlement", () => {
    it("should wait for worker settlement after a hold completes", () => {
      let hold!: ExecutionHold;
      const work = new ExecutionWork(execution, new AbortController().signal, [
        (ctx) => {
          hold = ctx.hold({ name: "workflow" });
        },
      ]);
      expect(work.ready()).toBe(false);
      hold.complete();
      work.emit({ type: "custom_message", customType: "unrelated", details: {} });
      expect(work.ready()).toBe(false);
      work.emit({ type: "agent_settled" });
      expect(work.ready()).toBe(true);
    });

    it("should allow host work to finish while the worker is idle", () => {
      let hold!: ExecutionHold;
      const work = new ExecutionWork(execution, new AbortController().signal, [
        (ctx) => {
          hold = ctx.hold({ name: "host" });
        },
      ]);
      work.emit({ type: "agent_settled" });
      hold.complete();
      expect(work.ready()).toBe(true);
      expect(work.retireWorker).toBe(false);
    });

    it("should await every parallel hold and ignore duplicate completion", () => {
      const holds: ExecutionHold[] = [];
      const work = new ExecutionWork(execution, new AbortController().signal, [
        (ctx) => {
          holds.push(ctx.hold({ name: "a" }), ctx.hold({ name: "b", retireWorker: true }));
        },
      ]);
      holds[1]!.complete();
      holds[1]!.complete();
      work.emit({ type: "agent_settled" });
      expect(work.ready()).toBe(false);
      holds[0]!.complete();
      expect(work.ready()).toBe(true);
      expect(work.retireWorker).toBe(true);
      work.emit({ type: "agent_start" });
      expect(work.ready()).toBe(false);
    });
  });

  describe("failures", () => {
    it("should preserve a failed hold", () => {
      let hold!: ExecutionHold;
      const work = new ExecutionWork(execution, new AbortController().signal, [
        (ctx) => {
          hold = ctx.hold({ name: "failed" });
        },
      ]);
      hold.fail(new Error("workflow failed"));
      expect(() => work.ready()).toThrow("workflow failed");
    });

    it("should reject new holds after disposal or cancellation", () => {
      let register!: () => ExecutionHold;
      const abort = new AbortController();
      const work = new ExecutionWork(execution, abort.signal, [
        (ctx) => {
          register = () => ctx.hold({ name: "late" });
        },
      ]);
      abort.abort();
      expect(register).toThrow("no longer running");
      work.close();
      expect(register).toThrow("no longer running");
    });
  });
});
