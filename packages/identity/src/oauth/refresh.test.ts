import { describe, expect, test } from "vitest";
import { createOAuthRefresher } from "./refresh.js";

describe("createOAuthRefresher", () => {
  test("persists a rotated refresh token with the new access token", async () => {
    const refresh = createOAuthRefresher(async () =>
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "bearer",
      }),
    );

    await expect(
      refresh({
        accessToken: "expired",
        refresh: {
          kind: "oauth",
          state: {
            tokenUrl: "https://provider.test/token",
            clientId: "client",
            refreshToken: "old-refresh",
          },
        },
      }),
    ).resolves.toMatchObject({
      accessToken: "new-access",
      refresh: { state: { refreshToken: "new-refresh" } },
    });
  });

  test("keeps the old refresh token when the provider does not rotate", async () => {
    const refresh = createOAuthRefresher(async () =>
      Response.json({ access_token: "new-access", expires_in: 3600, token_type: "bearer" }),
    );

    await expect(
      refresh({
        accessToken: "expired",
        refresh: {
          kind: "oauth",
          state: {
            tokenUrl: "https://provider.test/token",
            clientId: "client",
            refreshToken: "old-refresh",
          },
        },
      }),
    ).resolves.toMatchObject({
      accessToken: "new-access",
      refresh: { state: { refreshToken: "old-refresh" } },
    });
  });

  test("treats unhealable refresh state as a reconnect result instead of throwing forever", async () => {
    const refresh = createOAuthRefresher(async () => {
      throw new Error("must not be called");
    });

    await expect(
      refresh({
        accessToken: "expired",
        refresh: { kind: "oauth", state: { clientId: "client" } },
      }),
    ).resolves.toBeNull();
  });

  test("rethrows transient failures so the refresh stays retryable", async () => {
    const refresh = createOAuthRefresher(async () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
    );

    await expect(
      refresh({
        accessToken: "expired",
        refresh: {
          kind: "oauth",
          state: {
            tokenUrl: "https://provider.test/token",
            clientId: "client",
            refreshToken: "refresh",
          },
        },
      }),
    ).rejects.toThrow();
  });

  test("translates invalid_grant to a reconnect result", async () => {
    const refresh = createOAuthRefresher(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    await expect(
      refresh({
        accessToken: "expired",
        refresh: {
          kind: "oauth",
          state: {
            tokenUrl: "https://provider.test/token",
            clientId: "client",
            refreshToken: "refresh",
          },
        },
      }),
    ).resolves.toBeNull();
  });
});
