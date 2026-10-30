import * as z from "zod";
import type { ExecutionHold, ExecutionObservation, ExecutionObserver } from "@picco-agent/core";

/**
 * Pi-subagents 0.22 returns this metadata after accepting a saved workflow.
 */
const WorkflowStartSchema = z.object({ details: z.object({ taskId: z.string().min(1) }) });

/**
 * Completion outbox entries identify terminal tasks, including batched entries.
 */
const CompletionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "stopped", "error"]),
  error: z.string().optional(),
});

/**
 * The outbox places additional completions in the first completion's details.
 */
const BatchSchema = z.object({ others: z.array(z.unknown()).max(1000).optional() });

/**
 * Track saved workflows using existing structured RPC events, without dependency changes.
 */
export function observeWorkflows(ctx: ExecutionObservation): ExecutionObserver | void {
  if (ctx.execution.session.source !== "github-reviews") return;
  const launches = new Set<string>();
  const tasks = new Map<string, { hold: ExecutionHold; terminal: boolean }>();
  return {
    onEvent(event) {
      switch (event.type) {
        case "tool_start": {
          if (event.tool === "SubagentWorkflow") launches.add(event.toolCallId);
          break;
        }
        case "tool_end": {
          if (event.tool !== "SubagentWorkflow" || !launches.delete(event.toolCallId)) break;
          if (event.isError) break;
          const started = WorkflowStartSchema.parse(event.result);
          const id = started.details.taskId;
          if (tasks.has(id)) throw new Error("Workflow task ID was reused");
          tasks.set(id, {
            hold: ctx.hold({ name: `workflow:${id}`, retireWorker: true }),
            terminal: false,
          });
          break;
        }
        case "custom_message": {
          if (event.customType !== "subagent-notification") break;
          const batch = BatchSchema.parse(event.details);
          for (const candidate of [event.details, ...(batch.others ?? [])]) {
            const completion = CompletionSchema.safeParse(candidate);
            if (!completion.success) continue;
            const task = tasks.get(completion.data.id);
            if (!task || task.terminal) continue;
            task.terminal = true;
            if (completion.data.status === "completed") {
              task.hold.complete({ after: "next-settlement" });
            } else {
              task.hold.fail(new Error(completion.data.error ?? "Workflow stopped"));
            }
          }
          break;
        }
        case "agent_start":
        case "agent_settled":
          break;
      }
    },
  };
}
