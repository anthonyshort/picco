import * as z from "zod";
import type { FetchLike } from "../connector/connector.js";
import type { Credential } from "../credential/credentials.js";
import { OAuthError, refreshGrant } from "./grants.js";

const OAuthRefreshStateSchema = z.object({
  tokenUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  refreshToken: z.string().min(1),
  resource: z.url().optional(),
});

/**
 * Validated state required for an OAuth refresh grant.
 */
export type OAuthRefreshState = z.infer<typeof OAuthRefreshStateSchema>;

/**
 * Create the OAuth refresh operation used by credential resolution.
 */
export function createOAuthRefresher(
  fetchImpl: FetchLike,
): (credential: Credential) => Promise<Credential | null> {
  return async (credential) => {
    if (credential.refresh?.kind !== "oauth") return null;
    // A stored state that fails validation can never heal — treat it like a dead grant and send
    // the user back to /connect rather than throwing on every resolve.
    const state = OAuthRefreshStateSchema.safeParse(credential.refresh.state);
    if (!state.success) return null;
    try {
      const grant = await refreshGrant(state.data, fetchImpl);
      return {
        accessToken: grant.accessToken,
        expiresAt: grant.expiresAt,
        refresh: {
          kind: "oauth",
          // Providers that don't rotate omit the refresh token — keep the old one, or the next
          // refresh becomes impossible.
          state: { ...state.data, refreshToken: grant.refreshToken ?? state.data.refreshToken },
        },
      };
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_grant") return null;
      throw err;
    }
  };
}
