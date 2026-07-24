import { afterEach, describe, expect, test } from "vitest";
import * as z from "zod";
import { ToolBridge, type ToolBridgeOptions } from "./bridge.js";
import { tool, type Tool, type ToolContext } from "./tool.js";

let bridge: ToolBridge | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

async function startBridge(
  tools: Tool[],
  opts: Omit<ToolBridgeOptions, "tools"> = {},
): Promise<ToolBridge> {
  bridge = new ToolBridge({ tools: new Map(tools.map((t) => [t.name, t])), ...opts });
  await bridge.start();
  return bridge;
}

async function call(b: ToolBridge, token: string, body: unknown): Promise<Response> {
  return fetch(b.callUrl(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const weather = tool({
  name: "get_weather",
  description: "Get weather.",
  input: z.object({ city: z.string() }),
  execute: ({ city }) => `Sunny in ${city}`,
});

function replyTool() {
  return tool({
    name: "reply",
    description: "Reply to this conversation.",
    input: z.object({ text: z.string() }),
    execute: ({ text }) => `sent: ${text}`,
  });
}

describe("POST /call", () => {
  test("requires a valid session token", async () => {
    const b = await startBridge([weather]);

    const noAuth = await fetch(b.callUrl(), { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(b.callUrl(), {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    expect(badAuth.status).toBe(401);
  });

  test("executes a tool with the caller identified", async () => {
    const callers: ToolContext["caller"][] = [];
    const spy = tool({
      name: "get_weather",
      description: "Get weather.",
      input: z.object({ city: z.string() }),
      execute({ city }, ctx) {
        callers.push(ctx.caller);
        return `Sunny in ${city}`;
      },
    });
    const b = await startBridge([spy]);
    const token = b.issueToken({ source: "telegram", key: "42" });

    const res = await call(b, token, { tool: "get_weather", args: { city: "Sydney" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: [{ type: "text", text: "Sunny in Sydney" }],
      isError: false,
    });
    expect(callers).toEqual([{ kind: "session", ref: { source: "telegram", key: "42" } }]);
  });

  test("rich content results pass through untouched", async () => {
    const rich = tool({
      name: "rich",
      description: "Rich result.",
      input: z.object({}),
      execute: () => ({ content: [{ type: "text" as const, text: "block" }] }),
    });
    const b = await startBridge([rich]);

    const res = await call(b, b.issueToken({ source: "p", key: "k" }), { tool: "rich", args: {} });

    expect(await res.json()).toEqual({
      content: [{ type: "text", text: "block" }],
      isError: false,
    });
  });

  test("an unknown tool is an isError result, not a 4xx", async () => {
    const b = await startBridge([weather]);

    const res = await call(b, b.issueToken({ source: "p", key: "k" }), { tool: "nope", args: {} });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isError: boolean; content: { text: string }[] };
    expect(body.isError).toBe(true);
    expect(body.content[0]!.text).toContain('unknown tool "nope"');
  });

  test("args failing zod validation are an isError result, not a 4xx", async () => {
    const b = await startBridge([weather]);

    const res = await call(b, b.issueToken({ source: "p", key: "k" }), {
      tool: "get_weather",
      args: { city: 42 },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isError: boolean; content: { text: string }[] };
    expect(body.isError).toBe(true);
    expect(body.content[0]!.text).toContain("invalid arguments for get_weather");
  });

  test("a throwing tool is an isError result the model can react to", async () => {
    const bomb = tool({
      name: "bomb",
      description: "Always fails.",
      input: z.object({}),
      execute(): string {
        throw new Error("kaboom");
      },
    });
    const b = await startBridge([bomb]);

    const res = await call(b, b.issueToken({ source: "p", key: "k" }), { tool: "bomb", args: {} });

    expect(await res.json()).toEqual({
      content: [{ type: "text", text: "Error: kaboom" }],
      isError: true,
    });
  });

  test("malformed JSON and a missing tool name are protocol errors (400)", async () => {
    const b = await startBridge([weather]);
    const token = b.issueToken({ source: "p", key: "k" });

    const junk = await fetch(b.callUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(junk.status).toBe(400);

    const noTool = await call(b, token, { args: {} });
    expect(noTool.status).toBe(400);
  });

  test("binds to loopback only", async () => {
    const b = await startBridge([]);
    expect(b.callUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/call$/);
  });
});

describe("ToolContext.user", () => {
  /**
   * A spy tool recording the context of every execution.
   */
  function spyTool(seen: Pick<ToolContext, "user" | "token">[]) {
    return tool({
      name: "whoami",
      description: "d",
      input: z.object({}),
      execute(_, ctx) {
        // @ts-expect-error — ctx.connections is gone from ToolContext
        expect(ctx.connections).toBeUndefined();
        seen.push({ user: ctx.user, token: ctx.token });
        return "ok";
      },
    });
  }

  test("tools see the calling session's pinned sender, resolved per call", async () => {
    const seen: Pick<ToolContext, "user" | "token">[] = [];
    // The pin store a runtime would own — mutable, so the test can move the
    // pin between calls exactly as a new turn dequeuing would.
    const pins = new Map<string, { source: string; id: string }>();
    const b = await startBridge([spyTool(seen)], {
      currentUser: (ref) => pins.get(`${ref.source}/${ref.key}`),
    });
    const token = b.issueToken({ source: "telegram", key: "42" });

    pins.set("telegram/42", { source: "telegram", id: "123" });
    await call(b, token, { tool: "whoami", args: {} });
    pins.set("telegram/42", { source: "telegram", id: "456" });
    await call(b, token, { tool: "whoami", args: {} });

    // ctx.token stays absent through the bridge: only the identity
    // adapter's connector-tool wrapper ever injects it.
    expect(seen).toEqual([
      { user: { source: "telegram", id: "123" }, token: undefined },
      { user: { source: "telegram", id: "456" }, token: undefined },
    ]);
  });

  test("without a pin, ctx.user is absent", async () => {
    const seen: Pick<ToolContext, "user" | "token">[] = [];
    const b = await startBridge([spyTool(seen)]);

    await call(b, b.issueToken({ source: "cron", key: "job" }), { tool: "whoami", args: {} });

    expect(seen).toEqual([{ user: undefined, token: undefined }]);
  });
});

describe("session tokens", () => {
  test("revoking a session invalidates its tokens", async () => {
    const b = await startBridge([weather]);
    const token = b.issueToken({ source: "github", key: "pr-1" });
    const other = b.issueToken({ source: "github", key: "pr-2" });
    expect(b.tokenCount).toBe(2);

    b.releaseSession({ source: "github", key: "pr-1" });

    expect(b.tokenCount).toBe(1);
    const revoked = await call(b, token, { tool: "get_weather", args: { city: "x" } });
    expect(revoked.status).toBe(401);
    const stillValid = await call(b, other, { tool: "get_weather", args: { city: "x" } });
    expect(stillValid.status).toBe(200);
  });

  test("session-scoped tools are visible only to their session's token", async () => {
    const b = await startBridge([weather]);
    const bound = b.issueToken({ source: "telegram", key: "42" }, [replyTool()]);
    const plain = b.issueToken({ source: "telegram", key: "43" });

    const ok = await call(b, bound, { tool: "reply", args: { text: "hi" } });
    expect(await ok.json()).toEqual({
      content: [{ type: "text", text: "sent: hi" }],
      isError: false,
    });

    // Agent-wide tools remain visible to the bound token.
    const wide = await call(b, bound, { tool: "get_weather", args: { city: "x" } });
    expect(((await wide.json()) as { isError: boolean }).isError).toBe(false);

    const denied = await call(b, plain, { tool: "reply", args: { text: "hi" } });
    const body = (await denied.json()) as { isError: boolean };
    expect(body.isError).toBe(true);
  });

  test("name collisions and invalid shapes throw at mint time", async () => {
    const b = await startBridge([weather]);

    const dupOfAgentWide = tool({
      name: "get_weather",
      description: "d",
      input: z.object({}),
      execute: () => "",
    });
    expect(() => b.issueToken({ source: "p", key: "k" }, [dupOfAgentWide])).toThrow("collides");

    expect(() => b.issueToken({ source: "p", key: "k" }, [replyTool(), replyTool()])).toThrow(
      "collides",
    );

    const bad = tool({ name: "bad", description: "d", input: z.string(), execute: () => "" });
    expect(() => b.issueToken({ source: "p", key: "k" }, [bad])).toThrow("z.object");

    // Nothing was minted by the failed calls.
    expect(b.tokenCount).toBe(0);
  });
});
