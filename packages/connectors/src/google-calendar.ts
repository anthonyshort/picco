import type { Connector } from "@picco-agent/identity";

export interface GoogleCalendarConnectorOptions {
  clientId: string;
  clientSecret: string;
  /**
   * Google OAuth scopes the connection is granted (e.g.
   * `["https://www.googleapis.com/auth/calendar.events.readonly"]`). Required — the caller chooses
   * how much of the calendar to hand over.
   */
  scopes: string[];
}

/**
 * Create Google Calendar's hosted MCP connector using a registered Google OAuth client.
 */
export function googleCalendar(opts: GoogleCalendarConnectorOptions): Connector {
  return {
    name: "google-calendar",
    description:
      "Google Calendar — calendar access, scoped to what you grant (acts as your account)",
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
    mcp: { url: "https://calendarmcp.googleapis.com/mcp/v1" },
  };
}
