import { describe, expect, it } from "vitest";
import { ExecutionWork } from "../../packages/core/src/session/work.js";
import { observeWorkflows } from "./workflow-observer.js";

function work() {
  return new ExecutionWork(
    { id: "one", session: { source: "github-reviews", key: "review" } },
    new AbortController().signal,
    [observeWorkflows],
  );
}

function launch(execution: ExecutionWork, id: string) {
  execution.emit({ type: "tool_start", tool: "SubagentWorkflow", toolCallId: id, args: {} });
  execution.emit({
    type: "tool_end",
    tool: "SubagentWorkflow",
    toolCallId: id,
    isError: false,
    result: { details: { taskId: id } },
  });
}

describe("observeWorkflows", () => {
  describe("completion", () => {
    it("should handle parallel batched completions and duplicates", () => {
      const execution = work();
      launch(execution, "first");
      launch(execution, "second");
      execution.emit({ type: "agent_settled" });
      const completion = {
        type: "custom_message" as const,
        customType: "subagent-notification",
        details: {
          id: "first",
          status: "completed",
          others: [
            { id: "unknown", status: "completed" },
            { id: "second", status: "completed" },
          ],
        },
      };
      execution.emit(completion);
      execution.emit(completion);
      expect(execution.ready()).toBe(false);
      execution.emit({ type: "agent_start" });
      execution.emit({ type: "agent_settled" });
      expect(execution.ready()).toBe(true);
      expect(execution.retireWorker).toBe(true);
    });

    it("should handle completion before the parent's first settlement", () => {
      const execution = work();
      launch(execution, "first");
      execution.emit({
        type: "custom_message",
        customType: "subagent-notification",
        details: { id: "first", status: "completed" },
      });
      execution.emit({ type: "agent_settled" });
      expect(execution.ready()).toBe(true);
      launch(execution, "second");
      expect(execution.ready()).toBe(false);
    });
  });

  describe("failures", () => {
    it.each(["stopped", "error"])("should fail when a workflow is %s", (status) => {
      const execution = work();
      launch(execution, "first");
      execution.emit({
        type: "custom_message",
        customType: "subagent-notification",
        details: { id: "first", status, error: "task failed" },
      });
      expect(() => execution.ready()).toThrow("task failed");
    });

    it("should reject malformed accepted launches and task ID reuse", () => {
      const execution = work();
      launch(execution, "first");
      expect(() => launch(execution, "first")).toThrow("reused");
      execution.emit({ type: "tool_start", tool: "SubagentWorkflow", toolCallId: "bad", args: {} });
      expect(() =>
        execution.emit({
          type: "tool_end",
          tool: "SubagentWorkflow",
          toolCallId: "bad",
          isError: false,
          result: {},
        }),
      ).toThrow();
    });
  });
});
