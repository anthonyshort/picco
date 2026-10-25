import { z } from "zod";
import { SubagentDiagnosticSchema } from "@picco-agent/bridge-extension";

const EntrySchema = z.object({
  type: z.literal("entry_appended"),
  entry: z.object({
    type: z.literal("custom"),
    customType: z.literal("picco:subagent"),
    data: SubagentDiagnosticSchema.extend({ rootSessionId: z.string().min(1).max(512) }),
  }),
});

/**
 * Ignore unrelated entries and select metadata without copying conversation content.
 */
export function readSubagentDiagnostic(message: unknown) {
  const parsed = EntrySchema.safeParse(message);
  return parsed.success ? parsed.data.entry.data : undefined;
}
