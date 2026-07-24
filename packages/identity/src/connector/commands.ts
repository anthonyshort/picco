import type { Command, CommandContext, SessionIdentity } from "@picco-agent/core";
import {
  TokenRequestSchema,
  type ConnectorCatalog,
  type FetchLike,
  type TokenRequest,
} from "./connector.js";
import { Credentials, type ConnectionStatus } from "../credential/credentials.js";
import { resolveMcpAuthorization, type ClientMetadata } from "../mcp/discovery.js";
import { createOAuthCodeFlow } from "../oauth/code.js";

/**
 * Dependencies shared by the three connection commands.
 */
export interface ConnectionCommandsOptions {
  catalog: ConnectorCatalog;
  credentials: Credentials;
  callbackUrl?: string;
  redirectUri: string;

  /**
   * Resolved at dispatch time — the agent name arrives with the plugin context at start().
   */
  client(): ClientMetadata;
  fetch: FetchLike;
}

/**
 * Commands plus the callback operation needed by the OAuth listener.
 */
export interface ConnectionCommands {
  commands: Command[];
  completeOAuth(state: string, code: string): Promise<boolean>;
}

/**
 * User and private delivery target for one connection attempt.
 */
export interface ConnectionAttempt {
  user: SessionIdentity;
  connector: string;
  deliver(message: string): Promise<void>;
}

/**
 * Create the connection commands and their retained OAuth callback.
 */
export function createConnectionCommands(opts: ConnectionCommandsOptions): ConnectionCommands {
  const oauth = createOAuthCodeFlow({
    callbackUrl: opts.callbackUrl,
    redirectUri: opts.redirectUri,
    fetch: opts.fetch,
    async complete(connection, credential) {
      try {
        await opts.credentials.save(connection.user, connection.connector, credential);
      } catch (err) {
        await failConnection(connection, "failed").catch(() => {});
        throw err;
      }
      await connection.deliver(`✅ ${connection.connector} connected.`);
    },
    async fail(connection, reason) {
      await failConnection(connection, reason);
    },
  });

  return {
    commands: [
      {
        name: "connect",
        description: "Connect an account the agent can use as you",
        handler: (ctx) => connect(ctx, opts, oauth),
      },
      {
        name: "disconnect",
        description: "Remove a connected account",
        handler: (ctx) => disconnect(ctx, opts.catalog, opts.credentials),
      },
      {
        name: "connections",
        description: "List what you've connected",
        handler: (ctx) => list(ctx, opts.catalog, opts.credentials),
      },
    ],
    completeOAuth: oauth.complete,
  };
}

/**
 * Start, or paste back into, a connector's authentication flow.
 */
async function connect(
  ctx: CommandContext,
  opts: ConnectionCommandsOptions,
  oauth: ReturnType<typeof createOAuthCodeFlow>,
): Promise<void> {
  const user = await resolveCommandUser(ctx);
  if (!user) return;
  const [name = "", ...rest] = ctx.args.trim().split(/\s+/);
  if (!name) {
    await ctx.reply(
      `You can connect:\n${catalogLines(opts.catalog)}\nSend /connect <name> to start.`,
    );
    return;
  }
  const connector = opts.catalog.get(name);
  if (!connector) {
    await ctx.reply(`I don't know "${name}". You can connect:\n${catalogLines(opts.catalog)}`);
    return;
  }
  const directMessage = ctx.dm;
  if (!directMessage) {
    await ctx.reply(
      `I can't message you privately — open a DM with me and send /connect ${name} there.`,
    );
    return;
  }

  const connection: ConnectionAttempt = {
    user,
    connector: name,
    async deliver(message) {
      await directMessage(message).catch(async (err) => {
        await ctx.reply(
          `I couldn't DM you — open a private chat with me first, then send /connect ${name} there.`,
        );
        throw err;
      });
    },
  };
  const args = rest.join(" ");
  if (connector.auth.kind !== "token" && rest[0]?.startsWith("http")) {
    await oauth.resume(connection, args);
    return;
  }

  switch (connector.auth.kind) {
    case "token":
      try {
        await connectToken(connector.auth, connection, args, opts.credentials);
      } catch (err) {
        await failConnection(connection, errorReason(err)).catch(() => {});
      }
      return;
    case "oauth":
      try {
        await oauth.connect(connector.auth, connection);
      } catch (err) {
        await failConnection(connection, errorReason(err)).catch(() => {});
      }
      return;
    case "mcp":
      try {
        const request = await resolveMcpAuthorization(
          connector.auth,
          { redirectUri: opts.redirectUri, client: opts.client() },
          opts.fetch,
        );
        await oauth.connect(request, connection);
      } catch (err) {
        await failConnection(connection, errorReason(err)).catch(() => {});
      }
      return;
    default:
      throw new Error(`Unknown connection flow: ${(connector.auth as { kind: string }).kind}`);
  }
}

/**
 * Save a pasted token, or deliver instructions when it is absent.
 */
async function connectToken(
  request: TokenRequest,
  connection: ConnectionAttempt,
  args: string,
  credentials: Credentials,
): Promise<void> {
  const tokenRequest = TokenRequestSchema.parse(request);
  const token = args.trim();
  if (!token) {
    const hint = tokenRequest.instructions ? ` ${tokenRequest.instructions}` : "";
    await connection
      .deliver(
        `To connect ${connection.connector}, send me (in this private chat):\n` +
          `/connect ${connection.connector} <token>${hint}`,
      )
      .catch(() => {});
    return;
  }
  try {
    await credentials.save(connection.user, connection.connector, { accessToken: token });
  } catch {
    // A store/cipher failure has no teachable detail — never deliver its raw message.
    await failConnection(connection, "failed").catch(() => {});
    return;
  }
  await connection.deliver(`✅ ${connection.connector} connected.`).catch(() => {});
}

/**
 * Remove one connector credential for the requesting user.
 */
async function disconnect(
  ctx: CommandContext,
  catalog: ConnectorCatalog,
  credentials: Credentials,
): Promise<void> {
  const user = await resolveCommandUser(ctx);
  if (!user) return;
  const name = ctx.args.trim();
  if (!name || !catalog.has(name)) {
    await ctx.reply(`Usage: /disconnect <name>. You have:\n${catalogLines(catalog)}`);
    return;
  }
  try {
    const existed = await credentials.remove(user, name);
    await ctx.reply(existed ? `${name} disconnected.` : `You don't have ${name} connected.`);
  } catch {
    await ctx.reply(`Disconnecting ${name} failed — it may still be connected. Try again.`);
  }
}

/**
 * List the requesting user's non-secret connection metadata.
 */
async function list(
  ctx: CommandContext,
  catalog: ConnectorCatalog,
  credentials: Credentials,
): Promise<void> {
  const user = await resolveCommandUser(ctx);
  if (!user) return;
  let connections: ConnectionStatus[];
  try {
    connections = await credentials.list(user);
  } catch {
    await ctx.reply("Listing your connections failed. Try again.");
    return;
  }
  if (connections.length === 0) {
    await ctx.reply(`You haven't connected anything yet.\n${catalogLines(catalog)}`);
    return;
  }
  const lines = connections.map((connection) => {
    const stale = connection.stale
      ? ` (reconnect needed — send /connect ${connection.connector})`
      : "";
    return `- ${connection.connector}${stale}`;
  });
  await ctx.reply(`Connected:\n${lines.join("\n")}`);
}

/**
 * Resolve the authenticated command user or explain why one is required.
 */
async function resolveCommandUser(ctx: CommandContext): Promise<SessionIdentity | null> {
  if (ctx.user) return ctx.user;
  await ctx.reply("I can't tell who sent that — this command needs an identifiable sender.");
  return null;
}

/**
 * Format the configured connector catalog for command replies.
 */
function catalogLines(catalog: ConnectorCatalog): string {
  return [...catalog.values()]
    .map(
      (connector) =>
        `- ${connector.name}${connector.description ? ` — ${connector.description}` : ""}`,
    )
    .join("\n");
}

/**
 * Deliver the standard failed-connection reply. The generic "failed" reason renders without a
 * detail clause — it carries nothing the user can act on.
 */
async function failConnection(connection: ConnectionAttempt, reason: string): Promise<void> {
  const detail = reason && reason !== "failed" ? ` (${reason})` : "";
  await connection.deliver(
    `❌ Connecting ${connection.connector} failed${detail}. Try /connect again.`,
  );
}

/**
 * Resolve an error into the short reason safe to deliver to the user.
 */
function errorReason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "failed";
}
