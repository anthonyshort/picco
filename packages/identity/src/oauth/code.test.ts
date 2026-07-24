import { describe, expect, test } from "vitest";
import type { SessionIdentity } from "@picco-agent/core";
import type { OAuthCodeRequest } from "../connector/connector.js";
import type { ConnectionAttempt } from "../connector/commands.js";
import type { Credential } from "../credential/credentials.js";
import { createOAuthCodeFlow, type OAuthCodeFlow, type OAuthCodeFlowOptions } from "./code.js";

const request: OAuthCodeRequest = {
  kind: "oauth",
  clientId: "client",
  authorizationUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
};

describe("OAuth code", () => {
  describe("createOAuthCodeFlow", () => {
    test("completes its retained connection through a callback", async () => {
      const harness = createHarness();

      const state = await harness.beginConnect();

      expect(await harness.flow.complete(state, "authorization-code")).toBe(true);
      expect(harness.completions[0]).toMatchObject({
        accessToken: "access",
        refresh: { kind: "oauth", state: { refreshToken: "refresh" } },
      });
    });

    test("a state completes only once", async () => {
      const harness = createHarness();
      const state = await harness.beginConnect();

      expect(await harness.flow.complete(state, "authorization-code")).toBe(true);
      expect(await harness.flow.complete(state, "authorization-code")).toBe(false);
      expect(harness.completions).toHaveLength(1);
    });

    test("delivers the wire reason when the token exchange fails", async () => {
      const harness = createHarness({
        fetch: async () => Response.json({ error: "access_denied" }, { status: 400 }),
      });
      const state = await harness.beginConnect();

      expect(await harness.flow.complete(state, "authorization-code")).toBe(false);
      expect(harness.failures).toEqual(["access_denied"]);
    });

    test("reports failure when saving the granted credential throws", async () => {
      const harness = createHarness({
        complete: async () => {
          throw new Error("store is down");
        },
      });
      const state = await harness.beginConnect();

      expect(await harness.flow.complete(state, "authorization-code")).toBe(false);
      expect(harness.failures).toEqual(["failed"]);
    });

    describe("resume", () => {
      test("completes from a pasted callback URL", async () => {
        const harness = createHarness();
        const state = await harness.beginConnect();

        await harness.flow.resume(
          harness.connection(),
          `https://agent.test/oauth/callback?state=${state}&code=authorization-code`,
        );

        expect(harness.completions).toHaveLength(1);
      });

      test("asks the user to start over on garbage or unknown input", async () => {
        const harness = createHarness();
        await harness.beginConnect();

        await harness.flow.resume(harness.connection(), "not a url");
        await harness.flow.resume(
          harness.connection(),
          "https://agent.test/oauth/callback?state=unknown&code=code",
        );

        expect(harness.deliveries.filter((m) => m.includes("start over"))).toHaveLength(2);
        expect(harness.completions).toHaveLength(0);
      });

      test("rejects a pasted link belonging to another user's attempt", async () => {
        const harness = createHarness();
        const state = await harness.beginConnect();

        await harness.flow.resume(
          harness.connection({ source: "test", id: "intruder" }),
          `https://agent.test/oauth/callback?state=${state}&code=authorization-code`,
        );

        expect(harness.deliveries.at(-1)).toContain("different connect attempt");
        expect(harness.completions).toHaveLength(0);
      });
    });
  });
});

/**
 * Create a flow with recording collaborators and a token-granting fetch by default.
 */
function createHarness(overrides: Partial<OAuthCodeFlowOptions> = {}) {
  const deliveries: string[] = [];
  const completions: Credential[] = [];
  const failures: string[] = [];
  const user: SessionIdentity = { source: "test", id: "user" };
  const flow: OAuthCodeFlow = createOAuthCodeFlow({
    redirectUri: "https://agent.test/oauth/callback",
    callbackUrl: "https://agent.test/oauth/callback",
    fetch: async () =>
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "bearer",
      }),
    complete: async (_connection, credential) => void completions.push(credential),
    fail: async (_connection, reason) => void failures.push(reason),
    ...overrides,
  });
  const connection = (identity: SessionIdentity = user): ConnectionAttempt => ({
    user: identity,
    connector: "connector",
    deliver: async (message) => void deliveries.push(message),
  });
  return {
    flow,
    deliveries,
    completions,
    failures,
    connection,
    async beginConnect(): Promise<string> {
      await flow.connect(request, connection());
      const delivered = /https:\/\/\S+/.exec(deliveries.at(-1) ?? "");
      if (!delivered?.[0]) throw new Error("Authorization URL was not delivered");
      const state = new URL(delivered[0]).searchParams.get("state");
      if (!state) throw new Error("Authorization URL carried no state");
      return state;
    },
  };
}
