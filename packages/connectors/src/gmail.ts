import type { Connector } from "@picco-agent/identity";

export interface GmailConnectorOptions {
  clientId: string;
  clientSecret: string;
  /**
   * Google OAuth scopes the connection is granted (e.g.
   * `["https://www.googleapis.com/auth/gmail.readonly"]`). Required — the caller chooses how much
   * of the mailbox to hand over.
   */
  scopes: string[];
}

/**
 * Create Gmail's hosted MCP connector using a registered Google OAuth client.
 */
export function gmail(opts: GmailConnectorOptions): Connector {
  return {
    name: "gmail",
    description: "Gmail — mailbox access, scoped to what you grant (acts as your account)",
    auth: {
      kind: "oauth",
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: opts.scopes,
      // Refresh tokens for web-type clients require both.
      extraParams: { access_type: "offline", prompt: "consent" },
    },
    mcp: { url: "https://gmailmcp.googleapis.com/mcp/v1" },
  };
}
