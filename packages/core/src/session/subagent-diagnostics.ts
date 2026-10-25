import { z } from "zod";

/**
 * Selected metadata emitted by the patched pi-subagents extension.
 */
export const SubagentDiagnosticSchema = z.object({
  version: z.literal(1),
  event: z.enum(["started", "finished"]),
  agentId: z.string().min(1).max(128),
  parentAgentId: z.string().min(1).max(128).nullable(),
  status: z.string().min(1).max(64),
  model: z.string().min(1).max(512).nullable(),
  error: z.string().nullable(),
});

const EntrySchema = z.object({
  type: z.literal("entry_appended"),
  entry: z.object({
    type: z.literal("custom"),
    customType: z.literal("picco:subagent"),
    data: SubagentDiagnosticSchema.extend({ rootSessionId: z.string().min(1).max(512) }),
  }),
});

/**
 * Read subagent lifecycle entries and select fields for the server logger.
 */
export function readSubagentDiagnostic(message: unknown) {
  const parsed = EntrySchema.safeParse(message);
  return parsed.success ? parsed.data.entry.data : undefined;
}
