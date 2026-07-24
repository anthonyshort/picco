import * as z from "zod";
import type { ToolContext, ToolResult } from "@picco-agent/core";

/**
 * Validates pasted-token connector configuration.
 */
export const TokenRequestSchema = z.object({
  kind: z.literal("token"),
  instructions: z.string().optional(),
});

/**
 * Validates OAuth authorization-code connector configuration.
 */
export const OAuthCodeRequestSchema = z.object({
  kind: z.literal("oauth"),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  authorizationUrl: z.url(),
  tokenUrl: z.url(),
  resource: z.url().optional(),
  scopes: z.array(z.string()).max(100).optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

/**
 * Validates MCP discovery-based OAuth connector configuration.
 */
export const McpOAuthRequestSchema = z.object({
  kind: z.literal("mcp"),
  resource: z.url(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

/**
 * Fetch-compatible OAuth transport.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Request for a pasted personal token.
 */
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

/**
 * OAuth authorization-code connector configuration.
 */
export type OAuthCodeRequest = z.infer<typeof OAuthCodeRequestSchema>;

/**
 * MCP OAuth configuration resolved through discovery and optional registration.
 */
export type McpOAuthRequest = z.infer<typeof McpOAuthRequestSchema>;

/**
 * Authentication configuration accepted by a connector.
 */
export type ConnectorAuth = TokenRequest | OAuthCodeRequest | McpOAuthRequest;

/**
 * An MCP endpoint exposed through the credential proxy.
 */
export interface McpSurface {
  url: string;

  /**
   * Upstream header carrying the real token. Defaults to `Authorization`, which is Bearer-prefixed;
   * a custom header receives the raw token.
   */
  header?: string;
}

/**
 * Tool context extended with the connector's resolved per-user token.
 */
export interface ConnectorToolContext extends ToolContext {
  token: string;
}

/**
 * A host tool that receives only its connector's resolved token.
 */
export interface ConnectorTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  execute(input: z.infer<Input>, ctx: ConnectorToolContext): Promise<ToolResult> | ToolResult;
}

/**
 * Declarative service configuration and its authentication request.
 */
export interface Connector<Auth extends ConnectorAuth = ConnectorAuth> {
  /**
   * Unique connector name — the catalog key and the `/connect <name>` argument.
   */
  name: string;
  description?: string;
  auth: Auth;
  mcp?: McpSurface;
  tools?: ConnectorTool[];
}

/**
 * Connectors indexed by their unique command name.
 */
export type ConnectorCatalog = ReadonlyMap<string, Connector>;
