import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentDiagnosticSchema } from "../session/subagent-diagnostics.js";

/**
 * Forward subagent models and outcomes to Picco, including the reported error on failure.
 */
export default function subagentLogging(pi: ExtensionAPI): void {
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
