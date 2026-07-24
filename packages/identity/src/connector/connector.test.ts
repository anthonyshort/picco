import { describe, expect, test } from "vitest";
import { McpOAuthRequestSchema, OAuthCodeRequestSchema, TokenRequestSchema } from "./connector.js";

describe("connector request schemas", () => {
  test("accepts each supported authentication request", () => {
    expect(TokenRequestSchema.parse({ kind: "token", instructions: "Create one." })).toEqual({
      kind: "token",
      instructions: "Create one.",
    });
    expect(
      OAuthCodeRequestSchema.parse({
        kind: "oauth",
        clientId: "client",
        authorizationUrl: "https://provider.test/authorize",
        tokenUrl: "https://provider.test/token",
      }),
    ).toMatchObject({ clientId: "client" });
    expect(
      McpOAuthRequestSchema.parse({ kind: "mcp", resource: "https://mcp.test/mcp" }),
    ).toMatchObject({ resource: "https://mcp.test/mcp" });
  });

  test("bounds OAuth scopes and rejects malformed endpoints", () => {
    expect(() =>
      OAuthCodeRequestSchema.parse({
        kind: "oauth",
        clientId: "client",
        authorizationUrl: "not-a-url",
        tokenUrl: "https://provider.test/token",
      }),
    ).toThrow();
    expect(() =>
      OAuthCodeRequestSchema.parse({
        kind: "oauth",
        clientId: "client",
        authorizationUrl: "https://provider.test/authorize",
        tokenUrl: "https://provider.test/token",
        scopes: Array.from({ length: 101 }, (_, index) => `scope-${index}`),
      }),
    ).toThrow();
  });
});
