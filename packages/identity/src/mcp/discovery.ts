import * as z from "zod";
import {
  allowInsecureRequests,
  customFetch,
  discovery,
  None,
  type DiscoveryRequestOptions,
} from "openid-client";
import {
  McpOAuthRequestSchema,
  type FetchLike,
  type McpOAuthRequest,
  type OAuthCodeRequest,
} from "../connector/connector.js";
import { allowsInsecureEndpoint } from "../oauth/grants.js";

const RegisteredClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
});

const OAuthErrorSchema = z.object({ error: z.string() });

const ProtectedResourceSchema = z.object({
  resource: z.url(),
  authorization_servers: z.array(z.url()).max(20),
});

/**
 * How the agent presents itself to authorization servers during dynamic client registration.
 */
export interface ClientMetadata {
  clientName: string;
}

/**
 * OAuth endpoints selected from discovered server metadata.
 */
interface DiscoveredAuthorizationServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

/**
 * Client credentials supplied by configuration or dynamic registration.
 */
interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Discover and optionally register an MCP client, yielding a regular OAuth code request.
 */
export async function resolveMcpAuthorization(
  rawRequest: McpOAuthRequest,
  opts: { redirectUri: string; client: ClientMetadata },
  fetchImpl: FetchLike,
): Promise<OAuthCodeRequest> {
  const request = McpOAuthRequestSchema.parse(rawRequest);
  const discovered = await discoverAuthorizationServer(request.resource, fetchImpl);
  if (!request.clientId && !discovered.registrationEndpoint) {
    throw new Error(
      `the server doesn't support automatic client registration — use a token connector ` +
        `or configure this OAuth connector with your own client`,
    );
  }
  const client = request.clientId
    ? { clientId: request.clientId, clientSecret: request.clientSecret }
    : await registerClient(discovered.registrationEndpoint!, opts, fetchImpl);
  return {
    kind: "oauth",
    authorizationUrl: discovered.authorizationEndpoint,
    tokenUrl: discovered.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    resource: request.resource,
  };
}

/**
 * Find usable OAuth metadata from the resource's declared and origin issuers.
 */
async function discoverAuthorizationServer(
  resourceUrl: string,
  fetchImpl: FetchLike,
): Promise<DiscoveredAuthorizationServer> {
  const resource = new URL(resourceUrl);
  const issuers = await discoverIssuers(resource, fetchImpl);
  issuers.push(new URL(resource.origin));
  for (const issuer of issuers) {
    for (const algorithm of ["oauth2", "oidc"] as const) {
      try {
        const config = await discovery(issuer, "identity", undefined, None(), {
          algorithm,
          [customFetch]: (input, init) => fetchImpl(String(input), init),
          execute: allowsInsecureEndpoint(issuer.href) ? [allowInsecureRequests] : [],
        } satisfies DiscoveryRequestOptions);
        const metadata = config.serverMetadata();
        if (metadata.authorization_endpoint && metadata.token_endpoint) {
          return {
            authorizationEndpoint: metadata.authorization_endpoint,
            tokenEndpoint: metadata.token_endpoint,
            registrationEndpoint: metadata.registration_endpoint,
          };
        }
      } catch {
        // Try the next standard metadata layout or issuer.
      }
    }
  }
  throw new Error(`No OAuth authorization server discovered for ${resourceUrl}`);
}

/**
 * Register the agent as a public OAuth client.
 */
async function registerClient(
  registrationEndpoint: string,
  opts: { redirectUri: string; client: ClientMetadata },
  fetchImpl: FetchLike,
): Promise<RegisteredClient> {
  const response = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: opts.client.clientName,
      redirect_uris: [opts.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body: unknown = await response.json();
  const client = RegisteredClientSchema.safeParse(body);
  if (!response.ok || !client.success) {
    const error = OAuthErrorSchema.safeParse(body);
    const detail = error.success ? error.data.error : `HTTP ${response.status}`;
    throw new Error(`Dynamic client registration at ${registrationEndpoint} failed: ${detail}`);
  }
  return {
    clientId: client.data.client_id,
    clientSecret: client.data.client_secret,
  };
}

/**
 * Read authorization server issuers from protected-resource metadata.
 */
async function discoverIssuers(resource: URL, fetchImpl: FetchLike): Promise<URL[]> {
  const resourcePath = resource.pathname === "/" ? "" : resource.pathname;
  const metadataUrl = new URL(`/.well-known/oauth-protected-resource${resourcePath}`, resource);
  try {
    const response = await fetchImpl(metadataUrl.toString());
    if (!response.ok) return [];
    const metadata = ProtectedResourceSchema.safeParse(await response.json());
    if (!metadata.success || metadata.data.resource !== resource.href) return [];
    return metadata.data.authorization_servers.map((issuer) => new URL(issuer));
  } catch {
    return [];
  }
}
