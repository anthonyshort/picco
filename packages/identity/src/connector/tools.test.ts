import { describe, expect, test } from "vitest";
import * as z from "zod";
import { silentLogger, type SessionIdentity, type ToolContext } from "@picco-agent/core";
import { createCredentialCipher } from "../credential/cipher.js";
import { Credentials } from "../credential/credentials.js";
import type { IdentityStore, StoredEnvelope } from "../store/identity-store.js";
import type { Connector } from "./connector.js";
import { createConnectorTools } from "./tools.js";

const user: SessionIdentity = { source: "test", id: "user", display: "Ada" };

describe("createConnectorTools", () => {
  test("runs a connector tool with only its resolved token and the original context", async () => {
    const calls: { input: unknown; token: string; user?: SessionIdentity }[] = [];
    const connector: Connector = {
      name: "acme",
      auth: { kind: "token" },
      tools: [
        {
          name: "acme_search",
          description: "Search Acme",
          input: z.object({ query: z.string() }),
          execute(input, ctx) {
            calls.push({ input, token: ctx.token, user: ctx.user });
            return "found";
          },
        },
      ],
    };
    const credentials = createCredentials();
    const [tool] = createConnectorTools(new Map([[connector.name, connector]]), credentials);
    if (!tool) throw new Error("Expected connector tool");

    expect(await tool.execute({ query: "before" } as never, toolContext(user))).toContain(
      "/connect acme",
    );
    await credentials.save(user, "acme", { accessToken: "secret" });
    expect(await tool.execute({ query: "after" } as never, toolContext(user))).toBe("found");
    expect(calls).toEqual([{ input: { query: "after" }, token: "secret", user }]);
  });

  test("turns a transient resolution failure into a retry message, not a reconnect ask", async () => {
    const connector: Connector = {
      name: "acme",
      auth: { kind: "token" },
      tools: [
        {
          name: "acme_run",
          description: "Run Acme",
          input: z.object({}),
          execute: () => "ran",
        },
      ],
    };
    const credentials = createCredentials(async () => {
      throw new Error("token endpoint unreachable");
    });
    await credentials.save(user, "acme", {
      accessToken: "expired",
      expiresAt: 0,
      refresh: { kind: "oauth", state: refreshState() },
    });
    const [tool] = createConnectorTools(new Map([[connector.name, connector]]), credentials);
    if (!tool) throw new Error("Expected connector tool");

    const result = await tool.execute({} as never, toolContext(user));
    expect(result).toContain("Try again");
    expect(result).not.toContain("/connect");
  });

  test("refuses anonymous turns without resolving or running the connector", async () => {
    let calls = 0;
    const connector: Connector = {
      name: "acme",
      auth: { kind: "token" },
      tools: [
        {
          name: "acme_run",
          description: "Run Acme",
          input: z.object({}),
          execute() {
            calls++;
            return "ran";
          },
        },
      ],
    };
    const [tool] = createConnectorTools(
      new Map([[connector.name, connector]]),
      createCredentials(),
    );
    if (!tool) throw new Error("Expected connector tool");

    expect(await tool.execute({} as never, toolContext())).toContain("no user attached");
    expect(calls).toBe(0);
  });
});

/**
 * Create a minimal tool context for a connector invocation.
 */
function toolContext(identity?: SessionIdentity): ToolContext {
  return { logger: silentLogger(), caller: { kind: "host" }, user: identity };
}

/**
 * Create real credential custody over an in-memory store.
 */
function createCredentials(
  refresh: ConstructorParameters<typeof Credentials>[0]["refresh"] = async () => null,
): Credentials {
  const rows = new Map<string, StoredEnvelope>();
  const store: IdentityStore = {
    get: async (identity, connector) => rows.get(`${identity}/${connector}`) ?? null,
    set: async (identity, connector, envelope) =>
      void rows.set(`${identity}/${connector}`, envelope),
    remove: async (identity, connector) => rows.delete(`${identity}/${connector}`),
    list: async () => [],
  };
  return new Credentials({
    store,
    cipher: createCredentialCipher("b".repeat(64)),
    refresh,
    logger: () => undefined,
  });
}

/**
 * Create minimal OAuth refresh state for an expired credential.
 */
function refreshState() {
  return {
    tokenUrl: "https://provider.test/token",
    clientId: "client",
    refreshToken: "refresh",
  };
}
