import { describe, expect, test } from "vitest";
import { github } from "./github.js";

describe("github", () => {
  test("uses a registered client with GitHub's hosted MCP server", () => {
    expect(github({ clientId: "id", clientSecret: "secret", scopes: ["repo"] })).toMatchObject({
      name: "github",
      auth: {
        kind: "oauth",
        clientId: "id",
        clientSecret: "secret",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
      },
      mcp: { url: "https://api.githubcopilot.com/mcp/" },
    });
  });
});
