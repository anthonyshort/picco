import { describe, expect, test } from "vitest";
import type { FetchLike } from "../connector/connector.js";
import { resolveMcpAuthorization } from "./discovery.js";

describe("resolveMcpAuthorization", () => {
  test("discovers the authorization server and dynamically registers a client", async () => {
    const requests: { url: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = String(init?.body ?? "");
      requests.push({ url, body });
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.test/mcp",
          authorization_servers: ["https://auth.test"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://auth.test",
          authorization_endpoint: "https://auth.test/authorize",
          token_endpoint: "https://auth.test/token",
          registration_endpoint: "https://auth.test/register",
        });
      }
      if (url === "https://auth.test/register") {
        return Response.json({ client_id: "registered", client_secret: "secret" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    };

    const request = await resolveMcpAuthorization(
      { kind: "mcp", resource: "https://mcp.test/mcp" },
      { redirectUri: "https://agent.test/oauth/callback", client: { clientName: "Jarvis" } },
      fetchImpl,
    );

    expect(request).toEqual({
      kind: "oauth",
      authorizationUrl: "https://auth.test/authorize",
      tokenUrl: "https://auth.test/token",
      clientId: "registered",
      clientSecret: "secret",
      resource: "https://mcp.test/mcp",
    });
    const registration = requests.find(({ url }) => url === "https://auth.test/register");
    expect(registration?.body).toContain("https://agent.test/oauth/callback");
    expect(JSON.parse(registration!.body)).toMatchObject({ client_name: "Jarvis" });
  });

  test("uses a configured client without dynamic registration", async () => {
    const requests: string[] = [];
    const request = await resolveMcpAuthorization(
      {
        kind: "mcp",
        resource: "https://mcp.test/mcp",
        clientId: "configured",
        clientSecret: "secret",
      },
      { redirectUri: "https://agent.test/oauth/callback", client: { clientName: "Jarvis" } },
      async (url) => {
        requests.push(url);
        if (url.includes("oauth-authorization-server")) {
          return Response.json({
            issuer: "https://mcp.test",
            authorization_endpoint: "https://mcp.test/authorize",
            token_endpoint: "https://mcp.test/token",
          });
        }
        return new Response("not found", { status: 404 });
      },
    );

    expect(request.clientId).toBe("configured");
    expect(request.clientSecret).toBe("secret");
    expect(requests).not.toContain("https://mcp.test/register");
  });

  test("explains when discovery provides no client registration path", async () => {
    await expect(
      resolveMcpAuthorization(
        { kind: "mcp", resource: "https://mcp.test/mcp" },
        { redirectUri: "https://agent.test/oauth/callback", client: { clientName: "Jarvis" } },
        async (url) =>
          url.includes("oauth-authorization-server")
            ? Response.json({
                issuer: "https://mcp.test",
                authorization_endpoint: "https://mcp.test/authorize",
                token_endpoint: "https://mcp.test/token",
              })
            : new Response("not found", { status: 404 }),
      ),
    ).rejects.toThrow("doesn't support automatic client registration");
  });

  test("surfaces the wire error when dynamic registration is refused", async () => {
    await expect(
      resolveMcpAuthorization(
        { kind: "mcp", resource: "https://mcp.test/mcp" },
        { redirectUri: "https://agent.test/oauth/callback", client: { clientName: "Jarvis" } },
        async (url) => {
          if (url.includes("oauth-authorization-server")) {
            return Response.json({
              issuer: "https://mcp.test",
              authorization_endpoint: "https://mcp.test/authorize",
              token_endpoint: "https://mcp.test/token",
              registration_endpoint: "https://mcp.test/register",
            });
          }
          if (url === "https://mcp.test/register") {
            return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
          }
          return new Response("not found", { status: 404 });
        },
      ),
    ).rejects.toThrow("invalid_redirect_uri");
  });
});
