import type { Connector, McpOAuthRequest } from "@picco-agent/identity";

export interface McpConnectorOptions {
  name: string;
  /**
   * The MCP server URL — both where tool calls go and the OAuth discovery entry point.
   */
  url: string;
  /**
   * Shown by /connect; defaults to "<name> (MCP)".
   */
  description?: string;
  /**
   * Upstream auth header name. Defaults to `Authorization` with a Bearer prefix; a custom header
   * receives the raw token.
   */
  header?: string;
  /**
   * Pre-registered OAuth client. Leave both unset to register one dynamically (RFC 7591) at connect
   * time.
   */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Create a hosted MCP connector using OAuth metadata discovery.
 */
export function mcp(opts: McpConnectorOptions): Connector<McpOAuthRequest> {
  return {
    name: opts.name,
    description: opts.description ?? `${opts.name} (MCP)`,
    auth: {
      kind: "mcp",
      resource: opts.url,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    },
    mcp: { url: opts.url, header: opts.header },
  };
}
