import { afterEach, describe, expect, test } from "vitest";
import { silentLogger } from "@picco-agent/core";
import { McpProxy } from "./proxy.js";

const proxies: McpProxy[] = [];
const session = { source: "test", key: "channel" };

afterEach(async () => {
  for (const proxy of proxies) await proxy.stop();
  proxies.length = 0;
});

describe("McpProxy", () => {
  test("routes with isolated session bearers and injects the resolved credential", async () => {
    const requests: { headers: Headers; body: string }[] = [];
    const proxy = await startProxy({
      resolveToken: async (_session, connector) => ({ token: `${connector}-token` }),
      fetch: async (_url, init) => {
        requests.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return Response.json({ ok: true }, { headers: { "mcp-session-id": "upstream" } });
      },
    });
    const first = proxy.sessionServers(session).linear!;
    const second = proxy.sessionServers({ source: "test", key: "other" }).linear!;

    expect(first.headers.Authorization).not.toBe(second.headers.Authorization);
    const response = await fetch(first.url, {
      method: "POST",
      headers: {
        ...first.headers,
        cookie: "must-not-forward",
        "mcp-session-id": "downstream",
      },
      body: '{"id":1}',
    });

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer linear-token");
    expect(requests[0]?.headers.get("cookie")).toBeNull();
    expect(requests[0]?.headers.get("mcp-session-id")).toBe("downstream");
    expect(requests[0]?.body).toBe('{"id":1}');
    expect(response.headers.get("mcp-session-id")).toBe("upstream");
  });

  test("uses a custom route header without a bearer prefix", async () => {
    let headers = new Headers();
    const proxy = await startProxy({
      header: "X-Api-Key",
      resolveToken: async () => ({ token: "raw-token" }),
      fetch: async (_url, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });
    const server = proxy.sessionServers(session).linear!;

    await fetch(server.url, { method: "POST", headers: server.headers, body: "{}" });

    expect(headers.get("x-api-key")).toBe("raw-token");
    expect(headers.get("authorization")).toBeNull();
  });

  test("streams SSE response bytes without buffering", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message\ndata: one\n\n"));
        controller.enqueue(new TextEncoder().encode("event: message\ndata: two\n\n"));
        controller.close();
      },
    });
    const proxy = await startProxy({
      resolveToken: async () => ({ token: "token" }),
      fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    const server = proxy.sessionServers(session).linear!;

    const response = await fetch(server.url, { headers: server.headers });

    expect(await response.text()).toBe(
      "event: message\ndata: one\n\nevent: message\ndata: two\n\n",
    );
  });

  test("returns a JSON-RPC error without contacting upstream when resolution fails", async () => {
    let requests = 0;
    const proxy = await startProxy({
      resolveToken: async () => ({ error: "Send /connect linear." }),
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    });
    const server = proxy.sessionServers(session).linear!;

    const response = await fetch(server.url, {
      method: "POST",
      headers: server.headers,
      body: '{"jsonrpc":"2.0","id":7}',
    });

    expect(await response.json()).toMatchObject({
      id: 7,
      error: { message: "Send /connect linear." },
    });
    expect(requests).toBe(0);
  });

  test("404s unknown connectors and paths outside /mcp", async () => {
    const proxy = await startProxy({
      resolveToken: async () => ({ token: "token" }),
      fetch: async () => Response.json({ ok: true }),
    });
    const server = proxy.sessionServers(session).linear!;
    const origin = new URL(server.url).origin;

    expect((await fetch(`${origin}/mcp/unknown`, { headers: server.headers })).status).toBe(404);
    expect((await fetch(`${origin}/other`, { headers: server.headers })).status).toBe(404);
  });

  test("forwards a multibyte body without corruption", async () => {
    let body = "";
    const proxy = await startProxy({
      resolveToken: async () => ({ token: "token" }),
      fetch: async (_url, init) => {
        body = String(init?.body);
        return Response.json({ ok: true });
      },
    });
    const server = proxy.sessionServers(session).linear!;

    await fetch(server.url, {
      method: "POST",
      headers: server.headers,
      body: '{"text":"日本語のテキスト🚀"}',
    });

    expect(body).toBe('{"text":"日本語のテキスト🚀"}');
  });

  test("rejects forged and released session bearers", async () => {
    const proxy = await startProxy({
      resolveToken: async () => ({ token: "token" }),
      fetch: async () => Response.json({ ok: true }),
    });
    const server = proxy.sessionServers(session).linear!;

    expect((await fetch(server.url, { headers: { authorization: "Bearer forged" } })).status).toBe(
      401,
    );
    proxy.release(session);
    expect((await fetch(server.url, { headers: server.headers })).status).toBe(401);
  });
});

interface ProxyOverrides {
  header?: string;
  resolveToken: ConstructorParameters<typeof McpProxy>[0]["resolveToken"];
  fetch: ConstructorParameters<typeof McpProxy>[0]["fetch"];
}

async function startProxy(overrides: ProxyOverrides): Promise<McpProxy> {
  const proxy = new McpProxy({
    routes: new Map([
      [
        "linear",
        {
          url: "https://mcp.linear.test/mcp",
          header: overrides.header,
        },
      ],
    ]),
    resolveToken: overrides.resolveToken,
    fetch: overrides.fetch,
    logger: silentLogger(),
  });
  await proxy.start();
  proxies.push(proxy);
  return proxy;
}
