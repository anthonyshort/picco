import type { Tool } from "@picco-agent/core";
import type { ConnectorCatalog } from "./connector.js";
import { Credentials, userKey } from "../credential/credentials.js";

/**
 * Wrap connector tools with per-user credential resolution. Each call:
 *
 * 1. Requires a requesting user — cron/host turns are refused before the tool runs.
 * 2. Resolves that user's token for this connector (refreshing near expiry); unconnected users are
 *    told to /connect first.
 * 3. Only then calls the author's execute with the token on ctx.
 */
export function createConnectorTools(catalog: ConnectorCatalog, credentials: Credentials): Tool[] {
  const tools: Tool[] = [];
  for (const connector of catalog.values()) {
    for (const connectorTool of connector.tools ?? []) {
      tools.push({
        name: connectorTool.name,
        description: connectorTool.description,
        input: connectorTool.input,
        execute: async (args, ctx) => {
          if (!ctx.user) {
            return (
              `This tool acts as the requesting user, but this turn has no user ` +
              `attached (cron or host run). A person in chat must ask.`
            );
          }
          // Failures become the teachable error, never a throw — same stance as the MCP proxy,
          // and distinct from "not connected" so a transient outage never asks for a reconnect.
          let token: string | null;
          try {
            token = await credentials.resolve(ctx.user, connector.name);
          } catch (err) {
            ctx.logger.error("credential resolution failed", {
              connector: connector.name,
              error: err instanceof Error ? err.message : String(err),
            });
            return `Resolving credentials for ${connector.name} failed. Try again.`;
          }
          if (!token) {
            const who = ctx.user.display ?? userKey(ctx.user);
            return `${who} hasn't connected ${connector.name} — send /connect ${connector.name} first.`;
          }
          return connectorTool.execute(args, { ...ctx, token });
        },
      });
    }
  }
  return tools;
}
