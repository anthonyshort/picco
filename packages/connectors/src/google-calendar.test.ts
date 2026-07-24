import { describe, expect, test } from "vitest";
import { googleCalendar } from "./google-calendar.js";

describe("googleCalendar", () => {
  test("uses explicit Google OAuth with Calendar's hosted MCP server", () => {
    const scopes = ["https://www.googleapis.com/auth/calendar.events.readonly"];
    expect(googleCalendar({ clientId: "id", clientSecret: "secret", scopes })).toMatchObject({
      name: "google-calendar",
      auth: {
        kind: "oauth",
        clientId: "id",
        clientSecret: "secret",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes,
        extraParams: { access_type: "offline", prompt: "consent" },
      },
      mcp: { url: "https://calendarmcp.googleapis.com/mcp/v1" },
    });
  });
});
