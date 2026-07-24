import { describe, expect, test } from "vitest";
import { gmail } from "./gmail.js";

describe("gmail", () => {
  test("uses explicit Google OAuth with Gmail's hosted MCP server", () => {
    const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
    expect(gmail({ clientId: "id", clientSecret: "secret", scopes })).toMatchObject({
      name: "gmail",
      auth: {
        kind: "oauth",
        clientId: "id",
        clientSecret: "secret",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes,
        extraParams: { access_type: "offline", prompt: "consent" },
      },
      mcp: { url: "https://gmailmcp.googleapis.com/mcp/v1" },
    });
  });
});
