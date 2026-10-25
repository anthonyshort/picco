import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkerLogger } from "../utils/worker-logger.js";

/**
 * Send Pi session models and outcomes through the worker's existing stderr log stream.
 */
export default function subagentLogging(pi: ExtensionAPI): void {
  const logger = createWorkerLogger();
  let stopReason: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    logger.log("pi.session.started", sessionFields(ctx));
  });
  pi.on("agent_start", () => {
    stopReason = null;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    stopReason = message.stopReason;
    if (message.stopReason === "error") {
      logger.error("pi.model.failed", {
        ...sessionFields(ctx),
        model: `${message.provider}/${message.model}`,
        error: message.errorMessage,
      });
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    logger.log("pi.session.settled", { ...sessionFields(ctx), stopReason });
  });
}

/**
 * Identify the Pi session and its currently selected model.
 */
function sessionFields(ctx: ExtensionContext): Record<string, unknown> {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
  };
}
