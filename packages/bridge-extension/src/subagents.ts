import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  transcriptPath: z.string().min(1).max(4096).nullable(),
});

/**
 * Forward child identities and transcript paths to Picco without forwarding message content.
 */
export function observeSubagents(pi: ExtensionAPI): void {
  let rootSessionId: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    rootSessionId = ctx.sessionManager.getSessionId();
  });
  const unsubscribe = pi.events.on("subagents:diagnostic", (value: unknown) => {
    const parsed = SubagentDiagnosticSchema.safeParse(value);
    if (parsed.success && rootSessionId) {
      pi.appendEntry("picco:subagent", { ...parsed.data, rootSessionId });
    }
  });
  pi.on("session_shutdown", () => unsubscribe());
}
