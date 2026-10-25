import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Send Pi session models and outcomes through the worker's existing stderr log stream.
 */
export default function subagentLogging(pi: ExtensionAPI): void {
  let stopReason: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    logSession("pi.session.started", ctx);
  });
  pi.on("agent_start", () => {
    stopReason = null;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    stopReason = message.stopReason;
    if (message.stopReason === "error") {
      logSession("pi.model.failed", ctx, {
        model: `${message.provider}/${message.model}`,
        error: message.errorMessage,
      });
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    logSession("pi.session.settled", ctx, { stopReason });
  });
}

/**
 * Keep stdout reserved for Pi's RPC protocol.
 */
function logSession(event: string, ctx: ExtensionContext, fields?: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      sessionId: ctx.sessionManager.getSessionId(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      ...fields,
    }),
  );
}
