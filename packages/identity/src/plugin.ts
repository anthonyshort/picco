import type { Plugin, PluginContext, PluginResolveContext } from "@picco-agent/core";
import { createConnectionCommands } from "./connector/commands.js";
import {
  type Connector,
  type ConnectorCatalog,
  type FetchLike,
  type McpSurface,
} from "./connector/connector.js";
import { createConnectorTools } from "./connector/tools.js";
import { createCredentialCipher } from "./credential/cipher.js";
import { Credentials, userKey } from "./credential/credentials.js";
import { McpProxy } from "./mcp/proxy.js";
import { DEFAULT_CALLBACK_PORT, OAuthCallbackListener } from "./oauth/callback.js";
import { createOAuthRefresher } from "./oauth/refresh.js";
import type { IdentityStore } from "./store/identity-store.js";

/**
 * Loopback callback used for paste-back OAuth flows.
 */
const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/oauth/callback`;

/**
 * Agent configuration passed to a lazy identity store factory.
 */
export type StoreConfig = PluginResolveContext;

/**
 * Connections plugin configuration.
 */
export interface IdentityConfig {
  /**
   * 32-byte key sealing every stored credential, as 64 hex or 44 base64 chars — generate with
   * `openssl rand -hex 32`. Rotating it makes existing connections unreadable (users reconnect).
   */
  encryptionKey: string;

  /**
   * Where sealed envelopes persist. Pass an `IdentityStore` instance, or a factory function
   * receiving `{ dataDir, agentName }` so you can resolve paths lazily:
   *
   * ```ts
   * store: ({ dataDir }) => fileStore(path.join(dataDir, "connections")),
   * ```
   *
   * `fileStore(dir)` ships here; `@picco-agent/identity-sqlite` has a SQLite backend; implement
   * `IdentityStore` for anything else.
   */
  store: IdentityStore | ((config: StoreConfig) => IdentityStore);

  /**
   * Public URL OAuth providers redirect to. When set, a loopback listener serves its pathname and
   * completes flows automatically (front it with a proxy/tunnel). When absent, users paste the
   * callback URL back into chat instead.
   */
  callbackUrl?: string;

  /**
   * Loopback port for the callback listener (default 8976).
   */
  callbackPort?: number;

  /**
   * The services users can /connect.
   */
  connectors: Connector[];

  /**
   * OAuth/MCP transport override — a test seam.
   */
  fetch?: FetchLike;
}

/**
 * Create the per-user connections plugin.
 */
export function connections(config: IdentityConfig): Plugin {
  const catalog = createConnectorCatalog(config.connectors);
  const fetchImpl: FetchLike = config.fetch ?? fetch;
  const redirectUri = config.callbackUrl ?? DEFAULT_REDIRECT_URI;
  const routes = new Map<string, McpSurface>();
  for (const connector of catalog.values()) {
    if (connector.mcp) routes.set(connector.name, connector.mcp);
  }

  const storeOrFactory = config.store;
  const cipher = createCredentialCipher(config.encryptionKey);
  let host: PluginContext | null = null;
  let proxy: McpProxy | null = null;
  let callback: OAuthCallbackListener | null = null;
  let credentials: Credentials;
  let connectionCommands: ReturnType<typeof createConnectionCommands>;

  const plugin: Plugin = {
    name: "identity",

    resolve(ctx) {
      if (typeof storeOrFactory === "function") initialiseStore(storeOrFactory(ctx));
    },

    async start(ctx) {
      host = ctx;
      if (routes.size > 0) {
        proxy = new McpProxy({
          routes,
          fetch: fetchImpl,
          logger: ctx.logger,
          async resolveToken(session, connector) {
            const user = host?.currentUser(session);
            if (user) {
              // A transient resolve throw propagates — the proxy turns it into its retry
              // message rather than this "not connected" one.
              const token = await credentials.resolve(user, connector);
              if (token) return { token };
            }
            const who = user?.display ?? (user ? userKey(user) : null);
            return {
              error: who
                ? `${who} hasn't connected ${connector}. Ask them to send /connect ${connector}.`
                : `This turn has no user attached — a person must send /connect ${connector} first.`,
            };
          },
        });
        await proxy.start();
      }
      if (config.callbackUrl) {
        callback = new OAuthCallbackListener({
          callbackUrl: config.callbackUrl,
          port: config.callbackPort,
          complete: connectionCommands.completeOAuth,
          logger: ctx.logger,
        });
        await callback.start();
      }
      ctx.logger.log("identity plugin started", {
        connectors: [...catalog.keys()].join(", "),
      });
    },

    async stop() {
      await callback?.stop();
      callback = null;
      await proxy?.stop();
      proxy = null;
      host = null;
    },

    configureAllSessions(session, pi) {
      const contributed = proxy?.sessionServers(session) ?? {};
      const names = Object.keys(contributed);
      if (names.length === 0) return pi;
      const refreshNote =
        `Connector MCP servers (${names.join(", ")}) can't connect until their user runs ` +
        `/connect <name>. After a user connects, call mcp({ connect: "<name>" }) to connect ` +
        `and load that server's tools.`;
      return {
        ...pi,
        instructions: [pi.instructions, refreshNote].filter(Boolean).join("\n\n"),
        mcpServers: { ...pi.mcpServers, ...contributed },
      };
    },

    releaseSession(session) {
      proxy?.release(session);
    },
  };

  if (typeof storeOrFactory !== "function") initialiseStore(storeOrFactory);
  return plugin;

  /**
   * Create the credential services and publish commands and tools for the resolved store.
   */
  function initialiseStore(store: IdentityStore): void {
    credentials = new Credentials({
      store,
      cipher,
      refresh: createOAuthRefresher(fetchImpl),
      logger: () => host?.logger,
    });
    connectionCommands = createConnectionCommands({
      catalog,
      credentials,
      callbackUrl: config.callbackUrl,
      redirectUri,
      client: () => ({ clientName: host?.agentName ?? "agent" }),
      fetch: fetchImpl,
    });
    plugin.commands = connectionCommands.commands;
    plugin.tools = createConnectorTools(catalog, credentials);
  }
}

/**
 * Index connectors by name and reject ambiguous command configuration.
 */
function createConnectorCatalog(connectors: Connector[]): ConnectorCatalog {
  const catalog = new Map<string, Connector>();
  for (const connector of connectors) {
    if (!connector.name) throw new Error("Every connector needs a name");
    if (catalog.has(connector.name)) {
      throw new Error(`Duplicate connector name "${connector.name}"`);
    }
    catalog.set(connector.name, connector);
  }
  return catalog;
}
