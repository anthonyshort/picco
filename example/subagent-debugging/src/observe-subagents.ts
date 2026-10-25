import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentDiagnosticSchema } from "../../../packages/core/src/session/subagent-diagnostics.js";

/**
 * Forward child identities and transcript paths to Picco without forwarding message content.
 */
export default function observeSubagents(pi: ExtensionAPI): void {
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
