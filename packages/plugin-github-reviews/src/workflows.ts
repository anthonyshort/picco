import type { ExecutionHold, ExecutionObserver, PrepareExecutionContext } from "@picco-agent/core";
import { z } from "zod";

/**
 * Accepted workflow launches return their background task ID in tool result details.
 */
const WorkflowStartSchema = z.object({ details: z.object({ taskId: z.string().min(1) }) });

/**
 * Pi returns pre-launch validation failures as text-only results without task metadata.
 */
const WorkflowRejectionSchema = z.object({
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1)
    .max(100),
  details: z.undefined().optional(),
});

/**
 * Terminal notifications identify the task and optionally explain a failure.
 */
const CompletionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "stopped", "error"]),
  error: z.string().optional(),
});

/**
 * The first notification carries additional completions in its others field.
 */
const BatchSchema = z.object({ others: z.array(z.unknown()).max(1000).optional() });

/**
 * Lifecycle states retain released task IDs so later launches cannot reuse them.
 */
const WORKFLOW_STATUSES = ["running", "completed", "released"] as const;

/**
 * An accepted workflow owns one hold until completion or failure.
 */
interface WorkflowTask {
  hold: ExecutionHold;
  status: (typeof WORKFLOW_STATUSES)[number];
}

/**
 * Keep accepted review workflows in their execution until the parent has handled completion. State
 * belongs to one prompt, even when several prompts share a session.
 */
export function observeWorkflows(ctx: PrepareExecutionContext): ExecutionObserver | void {
  if (ctx.execution.session.source !== "github-reviews") {
    return;
  }
  const launches = new Set<string>();
  const tasks = new Map<string, WorkflowTask>();
  return {
    onEvent(event) {
      switch (event.type) {
        case "tool_start": {
          if (event.tool === "SubagentWorkflow") {
            launches.add(event.toolCallId);
          }
          break;
        }
        case "tool_end": {
          if (event.tool !== "SubagentWorkflow" || !launches.delete(event.toolCallId)) {
            break;
          }
          if (event.isError) {
            break;
          }
          if (WorkflowRejectionSchema.safeParse(event.result).success) {
            break;
          }
          const started = WorkflowStartSchema.parse(event.result);
          const id = started.details.taskId;
          if (tasks.has(id)) {
            throw new Error("Workflow task ID was reused");
          }
          tasks.set(id, {
            hold: ctx.hold({ name: `workflow:${id}`, retireWorker: true }),
            status: "running",
          });
          break;
        }
        case "custom_message": {
          if (event.customType !== "subagent-notification") {
            break;
          }
          const batch = BatchSchema.parse(event.details);
          for (const candidate of [event.details, ...(batch.others ?? [])]) {
            const completion = CompletionSchema.safeParse(candidate);
            if (!completion.success) {
              continue;
            }
            const task = tasks.get(completion.data.id);
            if (!task || task.status !== "running") {
              continue;
            }
            if (completion.data.status === "completed") {
              task.status = "completed";
            } else {
              task.status = "released";
              task.hold.fail(new Error(completion.data.error ?? "Workflow stopped"));
            }
          }
          break;
        }
        case "agent_settled": {
          // The completion notification starts a parent turn; wait for that turn to settle.
          for (const task of tasks.values()) {
            if (task.status === "completed") {
              task.status = "released";
              task.hold.complete();
            }
          }
          break;
        }
        case "agent_start": {
          break;
        }
        default: {
          throw new Error("Unknown workflow observer event");
        }
      }
    },
  };
}
