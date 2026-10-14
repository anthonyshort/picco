import { describe, expect, test } from "vitest";
import type { Command, SessionIdentity } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContextOptions } from "@picco-agent/core/testing";
import { createCredentialCipher } from "../credential/cipher.js";
import { Credentials } from "../credential/credentials.js";
import type { IdentityStore, StoredEnvelope } from "../store/identity-store.js";
import { createConnectionCommands } from "./commands.js";
import type { Connector } from "./connector.js";

const user: SessionIdentity = { source: "test", id: "user" };

describe("createConnectionCommands", () => {
  test("connects, lists, and disconnects a pasted-token connector", async () => {
    const credentials = createCredentials();
    const connector: Connector = {
      name: "acme",
      description: "Acme",
      auth: { kind: "token", instructions: "Create a token in settings." },
    };
    const { commands } = createConnectionCommands({
      catalog: new Map([[connector.name, connector]]),
      credentials,
      redirectUri: "http://127.0.0.1:8976/oauth/callback",
      client: () => ({ clientName: "test-agent" }),
      fetch: async () => new Response("not used", { status: 500 }),
    });
    const runner = createCommandRunner(commands);

    await runner.run("connect", "acme");
    expect(runner.directMessages[0]).toContain("Create a token in settings");

    await runner.run("connect", "acme secret");
    expect(runner.directMessages[1]).toContain("✅ acme connected");

    await runner.run("connections", "");
    expect(runner.replies[0]).toBe("Connected:\n- acme");

    await runner.run("disconnect", "acme");
    expect(runner.replies[1]).toBe("acme disconnected.");
    expect(await credentials.resolve(user, "acme")).toBeNull();
  });

  test("marks stale connections with reconnect guidance in the list", async () => {
    const credentials = createCredentials();
    await credentials.save(user, "acme", { accessToken: "expired", expiresAt: 0 });
    const connector: Connector = { name: "acme", auth: { kind: "token" } };
    const { commands } = createConnectionCommands({
      catalog: new Map([[connector.name, connector]]),
      credentials,
      redirectUri: "http://127.0.0.1:8976/oauth/callback",
      client: () => ({ clientName: "test-agent" }),
      fetch: async () => new Response("not used", { status: 500 }),
    });
    const runner = createCommandRunner(commands);

    await runner.run("connections", "");

    expect(runner.replies[0]).toContain("reconnect needed — send /connect acme");
  });

  test("replies instead of throwing when the store fails during disconnect", async () => {
    const connector: Connector = { name: "acme", auth: { kind: "token" } };
    const credentials = createCredentials({
      remove: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const { commands } = createConnectionCommands({
      catalog: new Map([[connector.name, connector]]),
      credentials,
      redirectUri: "http://127.0.0.1:8976/oauth/callback",
      client: () => ({ clientName: "test-agent" }),
      fetch: async () => new Response("not used", { status: 500 }),
    });
    const runner = createCommandRunner(commands);

    await runner.run("disconnect", "acme");

    expect(runner.replies[0]).toContain("may still be connected");
    expect(runner.replies[0]).not.toContain("EACCES");
  });

  test("refuses anonymous and non-private connection attempts", async () => {
    const connector: Connector = { name: "acme", auth: { kind: "token" } };
    const { commands } = createConnectionCommands({
      catalog: new Map([[connector.name, connector]]),
      credentials: createCredentials(),
      redirectUri: "http://127.0.0.1:8976/oauth/callback",
      client: () => ({ clientName: "test-agent" }),
      fetch: async () => new Response("not used", { status: 500 }),
    });
    const anonymous = createCommandRunner(commands, null);
    const publicOnly = createCommandRunner(commands, user, false);

    await anonymous.run("connect", "acme secret");
    await publicOnly.run("connect", "acme secret");

    expect(anonymous.replies[0]).toContain("identifiable sender");
    expect(publicOnly.replies[0]).toContain("open a DM");
  });

  test("reconnects an MCP connector in the current session as the command user", async () => {
    const { ctx, credentials } = createReconnectFixture();
    await credentials.save(user, "acme", { accessToken: "secret" });
    const session = await ctx.sessions.open("conversation");
    const replies: string[] = [];

    await ctx.commands.dispatch("mcp", {
      args: "reconnect acme",
      user,
      session,
      reply: async (message) => void replies.push(message),
    });

    expect(ctx.turns).toEqual([
      {
        source: "test",
        key: "conversation",
        prompt: "/mcp reconnect acme",
        user,
        session: undefined,
      },
    ]);
    expect(replies).toEqual([
      "Reconnect request for acme completed. Ask me to use the service again.",
    ]);
  });

  test.each([
    { args: "login acme", identity: user, hasSession: true, connected: true, reply: "Usage:" },
    {
      args: "reconnect acme extra",
      identity: user,
      hasSession: true,
      connected: true,
      reply: "Usage:",
    },
    {
      args: "reconnect missing",
      identity: user,
      hasSession: true,
      connected: true,
      reply: "No MCP connector",
    },
    {
      args: "reconnect local",
      identity: user,
      hasSession: true,
      connected: true,
      reply: "No MCP connector",
    },
    {
      args: "reconnect acme",
      identity: undefined,
      hasSession: true,
      connected: true,
      reply: "identifiable sender",
    },
    {
      args: "reconnect acme",
      identity: user,
      hasSession: false,
      connected: true,
      reply: "Send a message",
    },
    {
      args: "reconnect acme",
      identity: user,
      hasSession: true,
      connected: false,
      reply: "/connect acme first",
    },
  ])(
    "refuses reconnect with $args, user $identity, session $hasSession, credential $connected",
    async (opts) => {
      const { ctx, credentials } = createReconnectFixture();
      if (opts.connected) await credentials.save(user, "acme", { accessToken: "secret" });
      const session = opts.hasSession ? await ctx.sessions.open("conversation") : undefined;
      const replies: string[] = [];

      await ctx.commands.dispatch("mcp", {
        args: opts.args,
        user: opts.identity,
        session,
        reply: async (message) => void replies.push(message),
      });

      expect(ctx.turns).toEqual([]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain(opts.reply);
    },
  );

  test("reports worker reconnect failure while retaining the connected account", async () => {
    const { ctx, credentials } = createReconnectFixture({
      reply: () => {
        throw new Error("worker died");
      },
    });
    await credentials.save(user, "acme", { accessToken: "secret" });
    const session = await ctx.sessions.open("conversation");
    const replies: string[] = [];

    await ctx.commands.dispatch("mcp", {
      args: "reconnect acme",
      user,
      session,
      reply: async (message) => void replies.push(message),
    });

    expect(replies).toEqual(["Reconnecting acme failed. Try again."]);
    expect(await credentials.resolve(user, "acme")).toBe("secret");
  });

  test("MCP connection confirmation explains reconnect while token-only services need no extra step", async () => {
    const { ctx } = createReconnectFixture();
    const messages: string[] = [];
    for (const name of ["acme", "local"]) {
      await ctx.commands.dispatch("connect", {
        args: `${name} secret`,
        user,
        reply: async () => {},
        dm: async (message) => void messages.push(message),
      });
    }
    expect(messages).toEqual([
      "✅ acme connected. Send /mcp reconnect acme in each existing conversation where you want to use it.",
      "✅ local connected.",
    ]);
  });
});

/**
 * Exercise connection commands through a gateway context with a real credential store.
 */
function createReconnectFixture(opts: FakePluginContextOptions = {}) {
  const credentials = createCredentials();
  const connectors: Connector[] = [
    { name: "acme", auth: { kind: "token" }, mcp: { url: "https://mcp.acme.test" } },
    { name: "local", auth: { kind: "token" } },
  ];
  const { commands } = createConnectionCommands({
    catalog: new Map(connectors.map((connector) => [connector.name, connector])),
    credentials,
    redirectUri: "http://127.0.0.1:8976/oauth/callback",
    client: () => ({ clientName: "test-agent" }),
    fetch: async () => new Response("not used", { status: 500 }),
  });
  return { ctx: createFakePluginContext({ ...opts, source: "test", commands }), credentials };
}

/**
 * Run connection commands while recording their public and private replies.
 */
function createCommandRunner(
  commands: Command[],
  identity: SessionIdentity | null = user,
  hasDirectMessages = true,
) {
  const replies: string[] = [];
  const directMessages: string[] = [];
  return {
    replies,
    directMessages,
    async run(name: string, args: string): Promise<void> {
      const command = commands.find((candidate) => candidate.name === name);
      if (!command) throw new Error(`Missing command: ${name}`);
      await command.handler({
        user: identity ?? undefined,
        args,
        reply: async (message) => void replies.push(message),
        dm: hasDirectMessages ? async (message) => void directMessages.push(message) : undefined,
      });
    },
  };
}

/**
 * Create real credential custody over an in-memory store, with optional store overrides.
 */
function createCredentials(overrides: Partial<IdentityStore> = {}): Credentials {
  const rows = new Map<string, StoredEnvelope>();
  const store: IdentityStore = {
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
    ...overrides,
  };
  return new Credentials({
    store,
    cipher: createCredentialCipher("c".repeat(64)),
    refresh: async () => null,
    logger: () => undefined,
  });
}
