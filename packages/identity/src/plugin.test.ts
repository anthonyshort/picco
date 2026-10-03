import { afterEach, describe, expect, test } from "vitest";
import * as z from "zod";
import {
  createAgent,
  silentLogger,
  type Plugin,
  type PluginContext,
  type PluginResolveContext,
  type SessionIdentity,
} from "@picco-agent/core";
import { FakeRuntime, createFakePluginContext } from "@picco-agent/core/testing";
import type { Connector, FetchLike } from "./connector/connector.js";
import { connections, type IdentityConfig } from "./plugin.js";
import { createCredentialCipher } from "./credential/cipher.js";
import { userKey } from "./credential/credentials.js";
import type { IdentityStore, StoredEnvelope } from "./store/identity-store.js";

const KEY = "f".repeat(64);
const CALLBACK_TEST_PORT = 48976;
const plugins: Plugin[] = [];
const anthony: SessionIdentity = { source: "telegram", id: "123", display: "anthony" };
const sam: SessionIdentity = { source: "telegram", id: "456", display: "sam" };
const acme: Connector = withProbe({
  name: "acme",
  auth: {
    kind: "oauth",
    clientId: "acme-cid",
    authorizationUrl: "https://acme.example/authorize",
    tokenUrl: "https://acme.example/token",
    scopes: ["read"],
  },
});

afterEach(async () => {
  for (const plugin of plugins) await plugin.stop?.();
  plugins.length = 0;
});

describe("connections", () => {
  describe("construction", () => {
    test("lazy stores resolve at agent construction and back commands and tools", async () => {
      const store = createMemoryStore();
      const contexts: PluginResolveContext[] = [];
      const plugin = connections({
        encryptionKey: KEY,
        store: (ctx) => {
          contexts.push(ctx);
          return store;
        },
        connectors: [withProbe(token({ name: "sourcegraph" }))],
      });
      expect(contexts).toEqual([]);
      expect(plugin.commands).toBeUndefined();
      expect(plugin.tools).toBeUndefined();

      const agent = createAgent({
        name: "assistant",
        dataDir: "/tmp/identity-lazy-test",
        runtime: new FakeRuntime(),
        plugins: [plugin],
      });
      expect(contexts).toEqual([
        { dataDir: "/tmp/identity-lazy-test/assistant", agentName: "assistant" },
      ]);
      expect(plugin.commands?.map((command) => command.name)).toEqual([
        "connect",
        "disconnect",
        "connections",
      ]);

      const runner = createConnectRunner(plugin);
      await runner.connect("sourcegraph sgp_secret");
      expect(await store.get(userKey(anthony), "sourcegraph")).not.toBeNull();
      expect(await resolveProbeToken(plugin, "sourcegraph")).toBe("sgp_secret");
      await agent.stop();
    });

    test("a store factory failure propagates from agent construction", () => {
      const plugin = connections({
        encryptionKey: KEY,
        store: () => {
          throw new Error("store unavailable");
        },
        connectors: [],
      });
      expect(() =>
        createAgent({ name: "assistant", runtime: new FakeRuntime(), plugins: [plugin] }),
      ).toThrow("store unavailable");
    });

    test("invalid encryption keys fail before invoking a lazy store factory", () => {
      let called = false;
      expect(() =>
        connections({
          encryptionKey: "invalid",
          store: () => {
            called = true;
            return createMemoryStore();
          },
          connectors: [],
        }),
      ).toThrow();
      expect(called).toBe(false);
    });

    test("duplicate connector names throw", () => {
      expect(() =>
        connections({
          encryptionKey: KEY,
          store: createMemoryStore(),
          connectors: [token({ name: "x" }), mcp({ name: "x", url: "https://x" })],
        }),
      ).toThrow('Duplicate connector name "x"');
    });
  });

  describe("/connect", () => {
    test("bare /connect lists the catalog", async () => {
      const plugin = await startPlugin({
        connectors: [
          github({ clientId: "cid", clientSecret: "secret" }),
          token({ name: "sourcegraph" }),
        ],
      });
      const runner = createCommandRunner(plugin);

      await runner.run("connect", "");

      expect(runner.replies[0]).toContain("- github — GitHub");
      expect(runner.replies[0]).toContain("- sourcegraph");
    });

    test("unknown connectors get the catalog back, not an error", async () => {
      const plugin = await startPlugin({ connectors: [token({ name: "x" })] });
      const runner = createCommandRunner(plugin);

      await runner.run("connect", "nope");

      expect(runner.replies[0]).toContain('I don\'t know "nope"');
    });

    test("token paste: bare gives instructions, with a token stores it", async () => {
      const plugin = await startPlugin({
        connectors: [
          withProbe(
            token({ name: "sourcegraph", instructions: "Create one at sourcegraph.com/settings." }),
          ),
        ],
      });
      const runner = createCommandRunner(plugin);

      await runner.run("connect", "sourcegraph");
      expect(runner.directMessages[0]).toContain("/connect sourcegraph <token>");
      expect(runner.directMessages[0]).toContain("sourcegraph.com/settings");

      await runner.run("connect", "sourcegraph sgp_secret");
      expect(runner.directMessages[1]).toContain("✅");
      expect(await resolveProbeToken(plugin, "sourcegraph")).toBe("sgp_secret");
      expect(await resolveProbeToken(plugin, "sourcegraph", null)).toBeNull();
    });

    test("reports persistence failure without claiming the connector succeeded", async () => {
      const store = createMemoryStore();
      store.set = async () => {
        throw new Error("vault unavailable");
      };
      const plugin = await startPlugin({ connectors: [token({ name: "acme" })], store });
      const runner = createCommandRunner(plugin);

      await runner.run("connect", "acme secret");

      expect(runner.directMessages).toEqual(["❌ Connecting acme failed. Try /connect again."]);
    });
  });

  describe("key rotation", () => {
    test("an envelope under a previous key lists as stale, fails teachably on use, and /connect overwrites it", async () => {
      // Sealed under a PREVIOUS encryptionKey — the metadata is plaintext,
      // so without verification /connections would present it as healthy.
      const store = createMemoryStore();
      const previous = createCredentialCipher("a".repeat(64));
      await store.set(userKey(anthony), "acme", {
        v: 1,
        blob: await previous.seal({ accessToken: "old-tok" }, `${userKey(anthony)}/acme`),
        connectedAt: 111,
      });
      const plugin = await startPlugin({
        connectors: [withProbe(token({ name: "acme" }))],
        store,
      });
      const runner = createCommandRunner(plugin);

      await runner.run("connections", "");
      expect(runner.replies[0]).toContain("- acme (reconnect needed — send /connect acme)");

      // Resolution treats the undecryptable envelope as not connected — the
      // teachable error path, never an opaque throw.
      expect(await resolveProbeToken(plugin, "acme")).toBeNull();

      // Reconnecting overwrites the dead envelope cleanly.
      await runner.run("connect", "acme fresh-tok");
      expect(await resolveProbeToken(plugin, "acme")).toBe("fresh-tok");
      await runner.run("connections", "");
      expect(runner.replies.at(-1)).toBe("Connected:\n- acme");
    });
  });

  describe("IdentityStore contract", () => {
    test("a custom in-memory store carries connect → resolve → disconnect end to end", async () => {
      // The store third-party backends can copy: four async methods over
      // opaque envelopes (crypto stays above — see the sealed set values).
      const rows = new Map<string, StoredEnvelope>();
      const store: IdentityStore = {
        get: async (identity, connector) => rows.get(`${identity}/${connector}`) ?? null,
        set: async (identity, connector, envelope) =>
          void rows.set(`${identity}/${connector}`, envelope),
        remove: async (identity, connector) => rows.delete(`${identity}/${connector}`),
        list: async (identity) =>
          [...rows.entries()]
            .filter(([k]) => k.startsWith(`${identity}/`))
            .map(([k, e]) => ({
              connector: k.slice(identity.length + 1),
              connectedAt: e.connectedAt,
              expiresAt: e.expiresAt,
            })),
      };
      const plugin = await startPlugin({
        connectors: [withProbe(token({ name: "acme" }))],
        store,
      });
      const runner = createCommandRunner(plugin);

      await runner.run("connect", "acme tok-123");
      // Keyed by the canonical identity string; the envelope is sealed —
      // the store never sees the plaintext credential.
      expect(rows.has(`${userKey(anthony)}/acme`)).toBe(true);
      expect(JSON.stringify(rows.get(`${userKey(anthony)}/acme`))).not.toContain("tok-123");
      expect(await resolveProbeToken(plugin, "acme")).toBe("tok-123");

      await runner.run("disconnect", "acme");
      expect(rows.size).toBe(0);
      expect(await resolveProbeToken(plugin, "acme")).toBeNull();
    });
  });

  describe("MCP credential path", () => {
    test("resolves the session's current user through the vault before proxying upstream", async () => {
      const upstream = createFakeUpstream();
      const plugin = connections({
        encryptionKey: KEY,
        store: createMemoryStore(),
        connectors: [token({ name: "linear", mcp: { url: "https://mcp.linear.test/mcp" } })],
        fetch: upstream.fetchImpl,
      });
      const { host, pins } = createPinnedHost();
      await plugin.start!(host);
      try {
        await createCommandRunner(plugin, anthony).run("connect", "linear personal-token");
        pins.set("telegram/channel", anthony);
        const server = plugin.configureAllSessions!({ source: "telegram", key: "channel" }, {})
          .mcpServers?.linear;
        if (!server || !("url" in server)) throw new Error("linear proxy route was not configured");

        await fetch(server.url, { method: "POST", headers: server.headers, body: "{}" });

        expect(upstream.requests[0]?.headers.authorization).toBe("Bearer personal-token");
      } finally {
        await plugin.stop!();
      }
    });
  });

  describe("OAuth discovery and dynamic client registration", () => {
    test("a callback completes a discovered flow and stores its credential", async () => {
      const { fetchImpl, requests } = createLinearWeb();
      const plugin = await startPlugin({
        connectors: [withProbe(mcp({ name: "linear", url: "https://mcp.linear.app/mcp" }))],
        callbackUrl: "https://bot.example.com/oauth/callback",
        callbackPort: CALLBACK_TEST_PORT,
        fetch: fetchImpl,
      });
      const runner = createConnectRunner(plugin);

      await runner.connect("linear");

      const registration = requests.find((request) => request.url.includes("/register"));
      expect(registration?.body).toContain("https://bot.example.com/oauth/callback");
      const authorization = resolveAuthorizationUrl(runner.directMessages[0]!);
      expect(authorization.origin + authorization.pathname).toBe(
        "https://auth.linear.app/authorize",
      );
      expect(authorization.searchParams.get("client_id")).toBe("dcr-client");
      expect(authorization.searchParams.get("resource")).toBe("https://mcp.linear.app/mcp");
      expect(authorization.searchParams.get("code_challenge")).toBeTruthy();

      const response = await fetch(
        `http://127.0.0.1:${CALLBACK_TEST_PORT}/oauth/callback?state=${authorization.searchParams.get("state")}&code=authcode`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("You can close this tab");
      expect(runner.directMessages[1]).toContain("✅ linear connected");
      expect(await resolveProbeToken(plugin, "linear", anthony)).toBe("lin_at");
      const exchange = requests.find((request) =>
        request.body.includes("grant_type=authorization_code"),
      );
      expect(exchange?.body).toContain("code_verifier");
      expect(exchange?.body).toContain("client_id=dcr-client");
      expect(exchange?.body).toContain("resource=https%3A%2F%2Fmcp.linear.app%2Fmcp");
    });
  });

  describe("OAuth with explicit endpoints", () => {
    test("paste-back completes an authorization", async () => {
      const { fetchImpl, requests } = createFakeOAuthWeb({
        "/token": () => ({ access_token: "acme_at", expires_in: 3600 }),
      });
      const plugin = await startPlugin({ connectors: [acme], fetch: fetchImpl });
      const runner = createConnectRunner(plugin);

      await runner.connect("acme");

      expect(runner.directMessages[0]).toContain("copy the FULL URL");
      const authorization = resolveAuthorizationUrl(runner.directMessages[0]!);
      expect(authorization.searchParams.get("redirect_uri")).toContain("127.0.0.1");
      await runner.connect(
        `acme http://127.0.0.1:8976/oauth/callback?state=${authorization.searchParams.get("state")}&code=xyz`,
      );

      expect(runner.directMessages[1]).toContain("✅ acme connected");
      expect(await resolveProbeToken(plugin, "acme", anthony)).toBe("acme_at");
      expect(
        requests.find((request) => request.body.includes("authorization_code"))?.body,
      ).toContain("client_id=acme-cid");
    });

    test("a pasted URL from another user's flow is refused", async () => {
      const { fetchImpl } = createFakeOAuthWeb({ "/token": () => ({ access_token: "x" }) });
      const plugin = await startPlugin({ connectors: [acme], fetch: fetchImpl });
      const anthonyRunner = createConnectRunner(plugin, anthony);
      const samRunner = createConnectRunner(plugin, sam);

      await anthonyRunner.connect("acme");
      const state = resolveAuthorizationUrl(anthonyRunner.directMessages[0]!).searchParams.get(
        "state",
      );
      await samRunner.connect(`acme http://127.0.0.1:8976/oauth/callback?state=${state}&code=xyz`);

      expect(samRunner.directMessages[0]).toContain("different connect attempt");
      expect(await resolveProbeToken(plugin, "acme", anthony)).toBeNull();
      expect(await resolveProbeToken(plugin, "acme", sam)).toBeNull();
    });

    test("invalid paste-back input teaches the user to restart", async () => {
      const plugin = await startPlugin({
        connectors: [acme],
        fetch: createFakeOAuthWeb({}).fetchImpl,
      });
      const runner = createConnectRunner(plugin);

      await runner.connect("acme http://not-the-redirect.example/nope");

      expect(runner.directMessages[0]).toContain("Send /connect acme to start over");
    });

    test("concurrent tool calls share one refresh and persist the rotated credential", async () => {
      let refreshRequests = 0;
      let releaseRefresh: (() => void) | undefined;
      let markRefreshStarted: (() => void) | undefined;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const fetchImpl: FetchLike = async (_url, init) => {
        const params = new URLSearchParams(String(init?.body ?? ""));
        if (params.get("grant_type") === "authorization_code") {
          return Response.json({
            access_token: "expiring",
            refresh_token: "refresh-1",
            expires_in: 0,
            token_type: "bearer",
          });
        }
        refreshRequests++;
        markRefreshStarted?.();
        await refreshGate;
        return Response.json({
          access_token: "rotated",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "bearer",
        });
      };
      const plugin = await startPlugin({ connectors: [acme], fetch: fetchImpl });
      const runner = createConnectRunner(plugin);

      await runner.connect("acme");
      const authorization = resolveAuthorizationUrl(runner.directMessages[0]!);
      await runner.connect(
        `acme http://127.0.0.1:8976/oauth/callback?state=${authorization.searchParams.get("state")}&code=xyz`,
      );

      const first = resolveProbeToken(plugin, "acme");
      const second = resolveProbeToken(plugin, "acme");
      await refreshStarted;
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseRefresh?.();

      expect(await Promise.all([first, second])).toEqual(["rotated", "rotated"]);
      expect(refreshRequests).toBe(1);
      expect(await resolveProbeToken(plugin, "acme")).toBe("rotated");
      expect(refreshRequests).toBe(1);
    });
  });
});

/**
 * Create the token connector needed by plugin integration tests.
 */
function token(opts: { name: string; instructions?: string; mcp?: Connector["mcp"] }): Connector {
  return {
    name: opts.name,
    auth: { kind: "token", instructions: opts.instructions },
    mcp: opts.mcp,
  };
}

/**
 * Create the discovery-based MCP connector needed by plugin integration tests.
 */
function mcp(opts: { name: string; url: string }): Connector {
  return {
    name: opts.name,
    auth: { kind: "mcp", resource: opts.url },
    mcp: { url: opts.url },
  };
}

/**
 * Create an explicit OAuth connector with catalog metadata.
 */
function github(opts: { clientId: string; clientSecret: string }): Connector {
  return {
    name: "github",
    description: "GitHub",
    auth: {
      kind: "oauth",
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
    },
  };
}

/**
 * Run a plugin command while recording its public and private replies.
 */
function createCommandRunner(plugin: Plugin, user: SessionIdentity = anthony) {
  const replies: string[] = [];
  const directMessages: string[] = [];
  return {
    replies,
    directMessages,
    async run(name: "connect" | "disconnect" | "connections", args: string) {
      const command = plugin.commands?.find((candidate) => candidate.name === name);
      if (!command) throw new Error(`Missing command: ${name}`);
      await command.handler({
        user,
        args,
        reply: async (text) => void replies.push(text),
        dm: async (text) => void directMessages.push(text),
      });
    },
  };
}

/**
 * Create the minimal plugin host used by most integration tests.
 */
function createHost(): PluginContext {
  return createFakePluginContext({ source: "identity" });
}

/**
 * Create a host whose current session user can change during the test.
 */
function createPinnedHost(): {
  host: PluginContext;
  pins: Map<string, SessionIdentity>;
} {
  const pins = new Map<string, SessionIdentity>();
  return {
    host: createFakePluginContext({
      source: "identity",
      currentUser: ({ source, key }) => pins.get(`${source}/${key}`),
    }),
    pins,
  };
}

/**
 * Create an in-memory implementation of the public store contract.
 */
function createMemoryStore(): IdentityStore {
  const rows = new Map<string, StoredEnvelope>();
  return {
    get: async (identity, connector) => rows.get(`${identity}/${connector}`) ?? null,
    set: async (identity, connector, envelope) =>
      void rows.set(`${identity}/${connector}`, envelope),
    remove: async (identity, connector) => rows.delete(`${identity}/${connector}`),
    list: async (identity) =>
      [...rows.entries()]
        .filter(([key]) => key.startsWith(`${identity}/`))
        .map(([key, envelope]) => ({
          connector: key.slice(identity.length + 1),
          connectedAt: envelope.connectedAt,
          expiresAt: envelope.expiresAt,
        })),
  };
}

/**
 * Add a test-only tool that returns the resolved connector token.
 */
function withProbe(connector: Connector): Connector {
  return {
    ...connector,
    tools: [
      ...(connector.tools ?? []),
      {
        name: `${connector.name}_token`,
        description: "Echo the resolved token",
        input: z.object({}),
        execute: (_input, ctx) => ctx.token,
      },
    ],
  };
}

/**
 * Invoke a connector's test-only token probe.
 */
async function resolveProbeToken(
  plugin: Plugin,
  connector: string,
  user: SessionIdentity | null = anthony,
): Promise<string | null> {
  const probe = plugin.tools?.find((tool) => tool.name === `${connector}_token`);
  if (!probe) throw new Error(`Missing probe tool: ${connector}_token`);
  const result = await probe.execute({} as never, {
    logger: silentLogger(),
    caller: { kind: "host" },
    user: user ?? undefined,
  });
  if (typeof result !== "string") throw new Error("Probe returned rich content");
  return result.includes("hasn't connected") || result.includes("no user attached") ? null : result;
}

/**
 * Route OAuth requests through deterministic in-memory endpoint responses.
 */
function createFakeOAuthWeb(routes: Record<string, () => Record<string, unknown>>) {
  const requests: { url: string; body: string; params: URLSearchParams }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init?.body ? String(init.body) : "";
    requests.push({ url, body, params: new URLSearchParams(body) });
    const route = Object.entries(routes).find(([match]) => url.includes(match));
    if (!route) return new Response("not found", { status: 404 });
    const reply = route[1]();
    const status = url.includes("/register") ? 201 : typeof reply.error === "string" ? 400 : 200;
    const payload =
      typeof reply.access_token === "string" && !("token_type" in reply)
        ? { ...reply, token_type: "bearer" }
        : reply;
    return Response.json(payload, { status });
  };
  return { fetchImpl, requests };
}

/**
 * Record requests sent through the MCP credential proxy.
 */
function createFakeUpstream() {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      headers: Object.fromEntries(headers.entries()),
      body: String(init?.body ?? ""),
    });
    return Response.json(
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { headers: { "mcp-session-id": "up-1" } },
    );
  };
  return { fetchImpl, requests };
}

/**
 * Start and retain an identity plugin for automatic cleanup.
 */
async function startPlugin(config: Partial<IdentityConfig> & Pick<IdentityConfig, "connectors">) {
  const plugin = connections({
    encryptionKey: KEY,
    store: createMemoryStore(),
    ...config,
  });
  await plugin.start!(createHost());
  plugins.push(plugin);
  return plugin;
}

/**
 * Create a command runner with a shorthand for /connect.
 */
function createConnectRunner(plugin: Plugin, user = anthony) {
  const runner = createCommandRunner(plugin, user);
  return { ...runner, connect: (args: string) => runner.run("connect", args) };
}

/**
 * Create the discovered OAuth endpoints used by Linear tests.
 */
function createLinearWeb() {
  return createFakeOAuthWeb({
    "/.well-known/oauth-protected-resource": () => ({
      resource: "https://mcp.linear.app/mcp",
      authorization_servers: ["https://auth.linear.app"],
    }),
    "/.well-known/oauth-authorization-server": () => ({
      issuer: "https://auth.linear.app",
      authorization_endpoint: "https://auth.linear.app/authorize",
      token_endpoint: "https://auth.linear.app/token",
      registration_endpoint: "https://auth.linear.app/register",
    }),
    "/register": () => ({ client_id: "dcr-client" }),
    "/token": () => ({ access_token: "lin_at", refresh_token: "lin_rt", expires_in: 86_400 }),
  });
}

/**
 * Read the authorization URL from a private command reply.
 */
function resolveAuthorizationUrl(directMessage: string): URL {
  const match = /(https:\/\/[^\s]+)/.exec(directMessage);
  if (!match?.[1]) throw new Error("Authorization URL was not delivered");
  return new URL(match[1]);
}
