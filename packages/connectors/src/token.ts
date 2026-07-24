import type { Connector, McpSurface } from "@picco-agent/identity";

export interface TokenConnectorOptions {
  name: string;
  description?: string;
  /**
   * Where to create a token, shown by /connect (e.g. a settings URL).
   */
  instructions?: string;
  /**
   * Optional MCP surface the token authenticates.
   */
  mcp?: McpSurface;
}

/**
 * Create a connector whose users provide a personal token in a private message.
 */
export function token(opts: TokenConnectorOptions): Connector {
  return {
    name: opts.name,
    description: opts.description,
    auth: { kind: "token", instructions: opts.instructions },
    mcp: opts.mcp,
  };
}
