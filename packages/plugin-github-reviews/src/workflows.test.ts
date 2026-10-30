import { describe, expect, test } from "vitest";
import type { ExecutionHold, PrepareExecutionContext, WorkerEvent } from "@picco-agent/core";
import { observeWorkflows } from "./workflows.js";

/**
 * Record public hold operations without reproducing Picco's execution runtime.
 */
function execution({
  source = "github-reviews",
  id = "execution-one",
}: { source?: string; id?: string } = {}) {
  const holds: {
    name: string;
    retireWorker?: boolean;
    completed: number;
    failures: Error[];
  }[] = [];
  const context: PrepareExecutionContext = {
    execution: { id, session: { source, key: "same-session" } },
    signal: new AbortController().signal,
    hold(options): ExecutionHold {
      const record = { ...options, completed: 0, failures: new Array<Error>() };
      holds.push(record);
      return {
        complete() {
          record.completed++;
        },
        fail(error) {
          record.failures.push(error);
        },
      };
    },
  };
  const observer = observeWorkflows(context);
  return {
    holds,
    observer,
    emit(event: WorkerEvent) {
      if (!observer) {
        throw new Error("Expected a workflow observer");
      }
      observer.onEvent(event);
    },
    launch({ call = "call-one", task = "task-one" }: { call?: string; task?: string } = {}) {
      if (!observer) {
        throw new Error("Expected a workflow observer");
      }
      observer.onEvent({
        type: "tool_start",
        tool: "SubagentWorkflow",
        toolCallId: call,
        args: {},
      });
      observer.onEvent({
        type: "tool_end",
        tool: "SubagentWorkflow",
        toolCallId: call,
        isError: false,
        result: { details: { taskId: task } },
      });
    },
  };
}

/**
 * Deliver a Pi-subagents terminal notification through the public event shape.
 */
function notification(details: unknown): WorkerEvent {
  return { type: "custom_message", customType: "subagent-notification", details };
}

describe("review workflows", () => {
  test("workflow tracking is limited to GitHub review sessions", () => {
    for (const source of ["telegram", "cron", "host", "github-feedback"]) {
      const run = execution({ source });
      expect(run.observer).toBe(undefined);
      expect(run.holds).toEqual([]);
    }
    expect(execution().observer).toBeDefined();
  });

  test("a successful workflow waits for its completion and following settlement", () => {
    const run = execution();
    run.launch();
    expect(run.holds).toEqual([
      { name: "workflow:task-one", retireWorker: true, completed: 0, failures: [] },
    ]);
    run.emit({ type: "agent_settled" });
    expect(run.holds[0].completed).toBe(0);
    run.emit(notification({ id: "task-one", status: "completed" }));
    expect(run.holds[0].completed).toBe(0);
    run.emit({ type: "agent_start" });
    expect(run.holds[0].completed).toBe(0);
    run.emit({ type: "agent_settled" });
    run.emit(notification({ id: "task-one", status: "completed" }));
    run.emit({ type: "agent_settled" });
    expect(run.holds[0].completed).toBe(1);
    expect(run.holds[0].failures).toEqual([]);
  });

  test("only matched successful workflow tool calls acquire holds", () => {
    const run = execution();
    const end: WorkerEvent = {
      type: "tool_end",
      tool: "SubagentWorkflow",
      toolCallId: "call-one",
      isError: false,
      result: {},
    };
    run.emit(end);
    run.emit({ type: "tool_start", tool: "OtherTool", toolCallId: "call-one", args: {} });
    run.emit(end);
    run.emit({ type: "tool_start", tool: "SubagentWorkflow", toolCallId: "call-one", args: {} });
    run.emit({ ...end, tool: "OtherTool" });
    run.emit({ ...end, isError: true });
    run.emit(end);
    expect(run.holds).toEqual([]);
    run.launch();
    run.emit(end);
    expect(run.holds.length).toBe(1);
  });

  test("a pre-launch rejection permits a corrected launch in the same execution", () => {
    const run = execution();
    run.emit({
      type: "tool_start",
      tool: "SubagentWorkflow",
      toolCallId: "rejected",
      args: { name: "missing-review" },
    });
    run.emit({
      type: "tool_end",
      tool: "SubagentWorkflow",
      toolCallId: "rejected",
      isError: false,
      result: { content: [{ type: "text", text: "Unknown saved workflow: missing-review" }] },
    });
    expect(run.holds).toEqual([]);
    run.launch({ call: "corrected" });
    expect(run.holds.length).toBe(1);
    run.emit(notification({ id: "task-one", status: "completed" }));
    expect(run.holds[0].completed).toBe(0);
    run.emit({ type: "agent_settled" });
    expect(run.holds[0].completed).toBe(1);
  });

  test("malformed accepted launches and reused task IDs fail visibly", () => {
    for (const result of [
      undefined,
      {},
      { content: [] },
      { details: {} },
      { details: { taskId: "" } },
      { content: [{ type: "text", text: "Workflow accepted" }], details: { taskId: "" } },
    ]) {
      const run = execution();
      run.emit({ type: "tool_start", tool: "SubagentWorkflow", toolCallId: "call-one", args: {} });
      expect(() =>
        run.emit({
          type: "tool_end",
          tool: "SubagentWorkflow",
          toolCallId: "call-one",
          isError: false,
          result,
        }),
      ).toThrow();
      expect(run.holds).toEqual([]);
    }
    const run = execution();
    run.launch();
    run.emit(notification({ id: "task-one", status: "completed" }));
    run.emit({ type: "agent_settled" });
    expect(() => run.launch({ call: "call-two" })).toThrow("Workflow task ID was reused");
    expect(run.holds.length).toBe(1);
  });

  test("launches and task IDs belong to each execution even in the same session", () => {
    const first = execution();
    const second = execution({ id: "execution-two" });
    first.emit({ type: "tool_start", tool: "SubagentWorkflow", toolCallId: "call-one", args: {} });
    second.emit({
      type: "tool_end",
      tool: "SubagentWorkflow",
      toolCallId: "call-one",
      isError: false,
      result: {},
    });
    expect(second.holds.length).toBe(0);
    first.launch();
    second.launch();
    first.emit(notification({ id: "task-one", status: "completed" }));
    second.emit({ type: "agent_settled" });
    expect(second.holds[0].completed).toBe(0);
    first.emit({ type: "agent_settled" });
    expect(first.holds[0].completed).toBe(1);
  });

  test("batched and duplicate completions release only their own parallel tasks", () => {
    const run = execution();
    run.launch({ task: "first" });
    run.launch({ call: "call-two", task: "second" });
    run.launch({ call: "call-three", task: "third" });
    run.emit({
      type: "custom_message",
      customType: "unrelated",
      details: { id: "first", status: "completed" },
    });
    run.emit(
      notification({
        id: "unrelated",
        status: "completed",
        others: [
          null,
          { id: "first", status: "running" },
          { id: "first", status: "completed" },
          { id: "first", status: "completed" },
          { id: "second", status: "completed" },
        ],
      }),
    );
    expect(run.holds.map((hold) => hold.completed)).toEqual([0, 0, 0]);
    run.emit({ type: "agent_settled" });
    expect(run.holds.map((hold) => hold.completed)).toEqual([1, 1, 0]);
    run.emit(notification({ id: "third", status: "completed" }));
    run.emit({ type: "agent_settled" });
    expect(run.holds.map((hold) => hold.completed)).toEqual([1, 1, 1]);
  });

  test("terminal workflow failures fail their hold once and never complete it", () => {
    for (const completion of [
      { id: "task-one", status: "stopped" },
      { id: "task-one", status: "error", error: "Reviewer failed" },
    ]) {
      const run = execution();
      run.launch();
      run.emit(notification(completion));
      run.emit(notification(completion));
      run.emit({ type: "agent_settled" });
      expect(run.holds[0].failures.length).toBe(1);
      expect(run.holds[0].failures[0].message).toBe(completion.error ?? "Workflow stopped");
      expect(run.holds[0].completed).toBe(0);
    }
  });
});
