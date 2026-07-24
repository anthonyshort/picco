import { randomBytes } from "node:crypto";
import {
  OAuthCodeRequestSchema,
  type FetchLike,
  type OAuthCodeRequest,
} from "../connector/connector.js";
import { userKey, type Credential } from "../credential/credentials.js";
import type { ConnectionAttempt } from "../connector/commands.js";
import {
  buildAuthorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  OAuthError,
  type TokenGrant,
} from "./grants.js";

const FLOW_TTL_MINUTES = 15;
const FLOW_TTL_MS = FLOW_TTL_MINUTES * 60_000;

/**
 * OAuth code flow dependencies and completion behavior.
 */
export interface OAuthCodeFlowOptions {
  callbackUrl?: string;
  redirectUri: string;
  fetch: FetchLike;
  complete(connection: ConnectionAttempt, credential: Credential): Promise<void>;
  fail(connection: ConnectionAttempt, reason: string): Promise<void>;
}

/**
 * Retained OAuth authorization-code operations.
 */
export interface OAuthCodeFlow {
  connect(request: OAuthCodeRequest, connection: ConnectionAttempt): Promise<void>;
  resume(connection: ConnectionAttempt, input: string): Promise<void>;
  complete(state: string, code: string): Promise<boolean>;
}

interface PendingAuthorization {
  connection: ConnectionAttempt;
  verifier: string;
  request: OAuthCodeRequest;
}

/**
 * Create a retained OAuth authorization-code flow.
 */
export function createOAuthCodeFlow(opts: OAuthCodeFlowOptions): OAuthCodeFlow {
  const pending = new PendingAuthorizations(opts);
  return {
    async connect(rawRequest, connection) {
      const request = OAuthCodeRequestSchema.parse(rawRequest);
      const pkce = await createPkce();
      const state = pending.begin({
        connection,
        verifier: pkce.verifier,
        request,
      });
      const authorizationUrl = buildAuthorizationUrl(request, {
        redirectUri: opts.redirectUri,
        state,
        pkce,
      });
      await connection.deliver(
        opts.callbackUrl
          ? `To connect ${connection.connector}, open this link and approve access:\n${authorizationUrl}\n` +
              `I'll confirm here when it completes. The link expires in ${FLOW_TTL_MINUTES} minutes.`
          : `To connect ${connection.connector}, open this link and approve access:\n${authorizationUrl}\n` +
              `The final page will fail to load — copy the FULL URL from your browser's ` +
              `address bar and send it here as:\n/connect ${connection.connector} <that url>`,
      );
    },
    async resume(connection, input) {
      await resumeAuthorization(connection, input, pending);
    },
    complete: (state, code) => pending.complete(state, code),
  };
}

/**
 * Retain short-lived authorization requests until paste-back or callback completion.
 */
class PendingAuthorizations {
  private readonly flows = new Map<string, PendingAuthorization & { expiresAt: number }>();

  constructor(private readonly opts: OAuthCodeFlowOptions) {}

  begin(flow: PendingAuthorization): string {
    this.prune();
    const state = randomBytes(16).toString("hex");
    this.flows.set(state, { ...flow, expiresAt: Date.now() + FLOW_TTL_MS });
    return state;
  }

  peek(state: string): PendingAuthorization | undefined {
    this.prune();
    return this.flows.get(state);
  }

  async complete(state: string, code: string): Promise<boolean> {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow) return false;
    this.flows.delete(state);
    let credential: Credential;
    try {
      const grant = await exchangeAuthorizationCode(
        flow.request,
        { code, state, redirectUri: this.opts.redirectUri, verifier: flow.verifier },
        this.opts.fetch,
      );
      credential = createCredential(grant, flow.request);
    } catch (err) {
      const reason = err instanceof OAuthError ? err.code : "failed";
      await this.opts.fail(flow.connection, reason).catch(() => {});
      return false;
    }
    try {
      await this.opts.complete(flow.connection, credential);
      return true;
    } catch {
      // The provider granted tokens but saving/confirming failed — tell the user to retry rather
      // than leaving them with a silent "link expired" page.
      await this.opts.fail(flow.connection, "failed").catch(() => {});
      return false;
    }
  }

  private prune(): void {
    for (const [state, flow] of this.flows) {
      if (Date.now() >= flow.expiresAt) this.flows.delete(state);
    }
  }
}

/**
 * Resume a retained authorization from a pasted callback URL.
 */
async function resumeAuthorization(
  connection: ConnectionAttempt,
  input: string,
  pending: PendingAuthorizations,
): Promise<void> {
  let state: string | null = null;
  let code: string | null = null;
  try {
    const url = new URL(input);
    state = url.searchParams.get("state");
    code = url.searchParams.get("code");
  } catch {
    // Invalid URLs use the restart message below.
  }
  const flow = state ? pending.peek(state) : undefined;
  if (!state || !code || !flow) {
    await connection.deliver(
      `That doesn't look like the redirect URL I expected. Send /connect ${connection.connector} to start over.`,
    );
    return;
  }
  if (
    userKey(flow.connection.user) !== userKey(connection.user) ||
    flow.connection.connector !== connection.connector
  ) {
    await connection.deliver(
      `That link belongs to a different connect attempt. Send /connect ${connection.connector} to start over.`,
    );
    return;
  }
  await pending.complete(state, code);
}

/**
 * Create the stored credential and refresh state from a token grant.
 */
function createCredential(
  grant: TokenGrant,
  request: Pick<OAuthCodeRequest, "tokenUrl" | "clientId" | "clientSecret" | "resource">,
): Credential {
  return {
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    refresh: grant.refreshToken
      ? {
          kind: "oauth",
          state: {
            tokenUrl: request.tokenUrl,
            clientId: request.clientId,
            ...(request.clientSecret ? { clientSecret: request.clientSecret } : {}),
            ...(request.resource ? { resource: request.resource } : {}),
            refreshToken: grant.refreshToken,
          },
        }
      : undefined,
  };
}
