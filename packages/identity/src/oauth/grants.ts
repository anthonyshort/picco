import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl as createAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  Configuration,
  customFetch,
  None,
  randomPKCECodeVerifier,
  refreshTokenGrant,
  ResponseBodyError,
  type ServerMetadata,
  type TokenEndpointResponse,
} from "openid-client";
import type { FetchLike, OAuthCodeRequest } from "../connector/connector.js";
import type { OAuthRefreshState } from "./refresh.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalized output from an OAuth token endpoint.
 */
export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * PKCE verifier and derived challenge.
 */
export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * OAuth client metadata needed by `openid-client`.
 */
interface ClientConfig {
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  authorizationUrl?: string;
}

/**
 * OAuth protocol error with its wire error code.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OAuthError";
  }
}

/**
 * Create a fresh S256 PKCE verifier and challenge.
 */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomPKCECodeVerifier();
  const challenge = await calculatePKCECodeChallenge(verifier);
  return { verifier, challenge };
}

/**
 * Build an OAuth authorization URL from a validated code request.
 */
export function buildAuthorizationUrl(
  config: OAuthCodeRequest,
  opts: { redirectUri: string; state: string; pkce: Pkce },
): string {
  return createAuthorizationUrl(createClient(config), {
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.pkce.challenge,
    code_challenge_method: "S256",
    ...(config.resource ? { resource: config.resource } : {}),
    ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    ...config.extraParams,
  }).toString();
}

/**
 * Exchange an authorization code and PKCE verifier for a normalized token grant.
 */
export async function exchangeAuthorizationCode(
  config: Pick<OAuthCodeRequest, "clientId" | "clientSecret" | "tokenUrl" | "resource">,
  opts: { code: string; state: string; redirectUri: string; verifier: string },
  fetchImpl: FetchLike,
): Promise<TokenGrant> {
  const callback = new URL(opts.redirectUri, "http://localhost");
  callback.searchParams.set("code", opts.code);
  callback.searchParams.set("state", opts.state);
  try {
    return toGrant(
      await authorizationCodeGrant(
        createClient(config, fetchImpl),
        callback,
        {
          expectedState: opts.state,
          pkceCodeVerifier: opts.verifier,
        },
        config.resource ? { resource: config.resource } : undefined,
      ),
    );
  } catch (err) {
    throw createOAuthError(err);
  }
}

/**
 * Exchange validated OAuth refresh state for a normalized token grant, exactly as the provider
 * responded — callers own refresh-token preservation when the provider doesn't rotate.
 */
export async function refreshGrant(
  state: OAuthRefreshState,
  fetchImpl: FetchLike,
): Promise<TokenGrant> {
  try {
    return toGrant(
      await refreshTokenGrant(
        createClient(state, fetchImpl),
        state.refreshToken,
        state.resource ? { resource: state.resource } : undefined,
      ),
    );
  } catch (err) {
    throw createOAuthError(err);
  }
}

/**
 * Create an `openid-client` configuration for explicit provider endpoints.
 */
function createClient(config: ClientConfig, fetchImpl?: FetchLike): Configuration {
  const server: ServerMetadata = {
    issuer: new URL(config.tokenUrl).origin,
    token_endpoint: config.tokenUrl,
    ...(config.authorizationUrl ? { authorization_endpoint: config.authorizationUrl } : {}),
  };
  const client = new Configuration(
    server,
    config.clientId,
    {
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      token_endpoint_auth_method: config.clientSecret ? "client_secret_post" : "none",
    },
    config.clientSecret ? ClientSecretPost(config.clientSecret) : None(),
  );
  if (allowsInsecureEndpoint(config.tokenUrl)) allowInsecureRequests(client);
  if (fetchImpl) client[customFetch] = (input, init) => fetchImpl(String(input), init);
  return client;
}

/**
 * Permit a plain-http endpoint only on a loopback host (local development servers). A remote http
 * endpoint keeps `openid-client`'s HTTPS enforcement and fails loudly.
 */
export function allowsInsecureEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Normalize a standard OAuth token response.
 */
function toGrant(response: TokenEndpointResponse): TokenGrant {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt:
      response.expires_in !== undefined ? Date.now() + response.expires_in * 1000 : undefined,
  };
}

/**
 * Preserve protocol error codes behind one stable error type.
 */
function createOAuthError(err: unknown): OAuthError {
  if (err instanceof OAuthError) return err;
  if (err instanceof ResponseBodyError) {
    return new OAuthError(
      err.error,
      typeof err.error_description === "string" ? err.error_description : undefined,
    );
  }
  return new OAuthError("invalid_response", err instanceof Error ? err.message : String(err));
}
