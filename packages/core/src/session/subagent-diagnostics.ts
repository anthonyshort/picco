import { z } from "zod";
import type { JsonObject } from "./jsonl.js";
import { FailureSchema } from "./failure.js";

const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "limit_reached",
] as const;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "limit_reached",
]);

/**
 * Deliberate protocol copy: core observes the optional extension without importing its runtime.
 */
const DiagnosticDataSchema = z.object({
  status: z.enum(AGENT_STATUSES).optional(),
  depth: z.number().int().nonnegative().optional(),
  model: z.string().max(512).optional(),
  thinking: ThinkingSchema.optional(),
  requestedModel: z.string().max(512).optional(),
  requestedThinking: ThinkingSchema.optional(),
  transcriptPath: z.string().max(4096).optional(),
  manifestPath: z.string().max(4096).optional(),
  path: z
    .string()
    .max(4096)
    .regex(/^[^\r\n\t]*$/)
    .optional(),
  hook: z.string().max(128).optional(),
  durationMs: z.number().nonnegative().optional(),
  quietForMs: z.number().nonnegative().optional(),
  lastEvent: z.string().max(128).optional(),
  activeTools: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  tool: z.string().max(512).optional(),
  toolCallId: z.string().max(512).optional(),
  stopReason: z.string().max(64).optional(),
  reason: z
    .enum([
      "cancelled",
      "timed_out",
      "limit_reached",
      "failed",
      "manual",
      "threshold",
      "overflow",
      "authentication_rejected",
      "credentials_expired",
      "credentials_unavailable",
    ])
    .optional(),
  category: FailureSchema.shape.category.optional(),
  phase: FailureSchema.shape.phase.optional(),
  code: FailureSchema.shape.code,
  statusCode: FailureSchema.shape.statusCode,
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  attempt: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
  delayMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().nonnegative().optional(),
  maxTurns: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
  truncated: z.boolean().optional(),
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});
const DiagnosticEventSchema = z
  .object({
    version: z.literal(1),
    at: z.iso.datetime(),
    rootSessionId: z.string().min(1).max(512),
    executionId: z.string().min(1).max(512),
    agentId: z.string().min(1).max(512),
    parentAgentId: z.string().min(1).max(512).nullable(),
    event: z.enum([
      "agent.created",
      "agent.transcript",
      "agent.running",
      "agent.completed",
      "agent.failed",
      "agent.cancelled",
      "agent.timed_out",
      "agent.limit_reached",
      "agent.progress",
      "agent.turn",
      "agent.cancellation_requested",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "model.completed",
      "model.failed",
      "model.retry",
      "compaction.started",
      "compaction.completed",
      "compaction.failed",
      "persistence.failed",
      "cleanup.failed",
      "extension.failed",
    ]),
    data: DiagnosticDataSchema,
  })
  .strict();

const EntrySchema = z.object({
  type: z.literal("custom"),
  customType: z.literal("headless-subagents:event"),
  data: DiagnosticEventSchema,
});

/**
 * Select versioned descendant metadata; arbitrary fields are stripped at this boundary.
 */
export function readSubagentDiagnostic(message: JsonObject) {
  if (message.type !== "entry_appended") return;
  const parsed = EntrySchema.safeParse(message.entry);
  if (!parsed.success) return;
  const { event, data, ...identity } = parsed.data.data;
  return {
    event,
    data: { ...identity, ...data },
    isError:
      event.endsWith(".failed") || event === "agent.timed_out" || event === "agent.limit_reached",
    terminal: event.startsWith("agent.") && TERMINAL_STATUSES.has(event.slice(6)),
  };
}
