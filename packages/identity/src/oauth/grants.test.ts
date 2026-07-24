import { describe, expect, test } from "vitest";
import type { OAuthCodeRequest } from "../connector/connector.js";
import { buildAuthorizationUrl, exchangeAuthorizationCode } from "./grants.js";

const request: OAuthCodeRequest = {
  kind: "oauth",
  clientId: "client",
  clientSecret: "secret",
  authorizationUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
  resource: "https://resource.test/mcp",
  scopes: ["read", "write"],
  extraParams: { prompt: "consent" },
};

describe("OAuth grants", () => {
  test("builds the authorization request with PKCE and connector parameters", () => {
    const url = new URL(
      buildAuthorizationUrl(request, {
        redirectUri: "https://agent.test/oauth/callback",
        state: "state",
        pkce: { verifier: "verifier", challenge: "challenge" },
      }),
    );

    expect(url.origin + url.pathname).toBe("https://provider.test/authorize");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("resource")).toBe("https://resource.test/mcp");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("normalizes a standard authorization-code token response", async () => {
    let body = "";

    const grant = await exchangeAuthorizationCode(
      request,
      {
        code: "code",
        state: "state",
        redirectUri: "https://agent.test/oauth/callback",
        verifier: "verifier",
      },
      async (_url, init) => {
        body = String(init?.body ?? "");
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "bearer",
        });
      },
    );

    expect(grant).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(body).toContain("code_verifier=verifier");
    expect(body).toContain("client_secret=secret");
  });

  test("preserves the wire error code when the token exchange is rejected", async () => {
    await expect(
      exchangeAuthorizationCode(
        request,
        {
          code: "code",
          redirectUri: "https://agent.test/oauth/callback",
          state: "state",
          verifier: "verifier",
        },
        async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: "OAuthError", code: "invalid_grant" }));
  });

  test("refuses a plain-http token endpoint unless it is loopback", async () => {
    const tokens = async () =>
      Response.json({ access_token: "access", token_type: "bearer" as const });
    const exchange = (tokenUrl: string) =>
      exchangeAuthorizationCode(
        { ...request, tokenUrl },
        {
          code: "code",
          redirectUri: "https://agent.test/oauth/callback",
          state: "state",
          verifier: "verifier",
        },
        tokens,
      );

    await expect(exchange("http://127.0.0.1:3001/token")).resolves.toMatchObject({
      accessToken: "access",
    });
    await expect(exchange("http://provider.test/token")).rejects.toThrow();
  });
});
