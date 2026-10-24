import { z } from "zod";
import type {
  AgentSessionEvent,
  ExtensionToolContext,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
type ThinkingLevel = NonNullable<ExtensionToolContext["thinkingLevel"]>;
type Settings = ReturnType<ExtensionAPI["getSettings"]>;

export const AGENT_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "limit_reached",
] as const;
export const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SettingsSchema = z
  .object({
    outputDirectory: z.string().min(1).optional(),
    maxActive: z.number().int().min(1).max(64).default(4),
    maxDepth: z.number().int().min(1).max(16).default(3),
    timeoutMs: z.number().int().min(1).max(86_400_000).default(900_000),
    maxTurns: z.number().int().min(1).max(10_000).default(100),
  })
  .strict();
export type SubagentSettings = z.infer<typeof SettingsSchema>;
export const SpawnSchema = z
  .object({
    prompt: z.string().min(1).max(262_144),
    label: z.string().min(1).max(120).optional(),
    model: z.string().min(3).max(512).optional(),
    thinking: ThinkingSchema.optional(),
    timeoutMs: z.number().int().min(1).optional(),
    maxTurns: z.number().int().min(1).optional(),
  })
  .strict();
export type SpawnInput = z.infer<typeof SpawnSchema>;
export const ResultInputSchema = z
  .object({
    agentId: z.string().min(1).max(128),
    wait: z.boolean().optional(),
  })
  .strict();
export const StopInputSchema = z.object({ agentId: z.string().min(1).max(128) }).strict();
export const ListInputSchema = z
  .object({
    offset: z.number().int().min(0).max(10_000).default(0),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict();
export const FAILURE_CATEGORIES = [
  "authentication",
  "permission",
  "rate_limit",
  "provider_unavailable",
  "network",
  "context_limit",
  "output_limit",
  "timeout",
  "cancelled",
  "limit",
  "runtime",
  "extension",
  "cleanup",
  "persistence",
  "unknown",
] as const;
export const FAILURE_PHASES = [
  "startup",
  "model",
  "tool",
  "compaction",
  "cleanup",
  "persistence",
] as const;
export const FailureSchema = z.object({
  category: z.enum(FAILURE_CATEGORIES),
  phase: z.enum(FAILURE_PHASES),
  code: z
    .enum([
      "auth",
      "oauth",
      "model_source",
      "model_validation",
      "provider",
      "stream",
      "token_expired",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
    ])
    .optional(),
  statusCode: z.number().int().min(400).max(599).optional(),
  reason: z
    .enum(["authentication_rejected", "credentials_expired", "credentials_unavailable"])
    .optional(),
});
export type Failure = z.infer<typeof FailureSchema>;
export const AgentRecordSchema = z.object({
  id: z.string(),
  rootSessionId: z.string(),
  executionId: z.string(),
  parentAgentId: z.string().nullable(),
  depth: z.number().int(),
  label: z.string().max(120).optional(),
  status: z.enum(AGENT_STATUSES),
  requestedModel: z.string().max(512).optional(),
  requestedThinking: ThinkingSchema.optional(),
  model: z.string().max(512).optional(),
  thinking: ThinkingSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  timeoutMs: z.number().int(),
  maxTurns: z.number().int(),
  turns: z.number().int().default(0),
  toolUses: z.number().int().default(0),
  usage: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      cost: z.number(),
    })
    .optional(),
  transcriptPath: z.string().nullable(),
  failure: FailureSchema.optional(),
  cleanupFailure: FailureSchema.optional(),
  persistenceFailure: FailureSchema.optional(),
  partial: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
export const DiagnosticDataSchema = z.object({
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
    .regex(/^[^\r\n\t]+$/)
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
export const DiagnosticEventSchema = z
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
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

/**
 * Live caller state; never serialised into diagnostic metadata.
 */
export interface AgentOwner<Context = ExtensionToolContext> {
  id: string | null;
  context: Context;
  model: string;
  thinking: ThinkingLevel;
  activeTools: string[];
  inheritedTools: ReturnType<ExtensionAPI["getAllTools"]>;
  settings: Settings;
}

/**
 * One SDK child, whose lifecycle remains owned by the coordinator.
 */
export interface ChildRunner {
  model: string;
  thinking: ThinkingLevel;
  transcriptPath: string;
  run(prompt: string): Promise<{
    output: string;
    error?: string;
    failure?: Failure;
    aborted?: boolean;
    truncated?: boolean;
  }>;
  currentOutput(): string;
  abort(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Inputs needed to initialise a fresh SDK session in the caller's existing sandbox.
 */
export interface ChildRunnerOptions<Context = ExtensionToolContext> {
  record: AgentRecord;
  owner: AgentOwner<Context>;
  input: SpawnInput;
  transcriptDirectory: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
  onEvent(event: AgentSessionEvent): void;
  onTranscript(path: string): void;
  onDiagnostic(event: DiagnosticEvent["event"], data: DiagnosticEvent["data"]): void;
}
export type CreateChildRunner<Context = ExtensionToolContext> = (
  options: ChildRunnerOptions<Context>,
) => Promise<ChildRunner>;
