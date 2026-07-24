import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { callBridge, readBridgeConfig, toAgentResult } from "./index.js";
import type { BridgeCallResult, BridgeConfig } from "./index.js";

let tmpdir: string;
let configPath: string;

beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), "bridge-ext-test-"));
  configPath = path.join(tmpdir, "bridge.json");
});

afterEach(() => {
  rmSync(tmpdir, { recursive: true, force: true });
});

function writeConfig(config: BridgeConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

describe("readBridgeConfig", () => {
  test("reads a valid config", () => {
    writeConfig({
      url: "http://127.0.0.1:9999/call",
      token: "abc123",
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object" } }],
    });

    const config = readBridgeConfig(configPath);
    expect(config.url).toBe("http://127.0.0.1:9999/call");
    expect(config.token).toBe("abc123");
    expect(config.tools).toEqual([
      { name: "test_tool", description: "A test tool", inputSchema: { type: "object" } },
    ]);
  });

  test("accepts a config with no tools", () => {
    writeConfig({ url: "http://127.0.0.1:9999/call", token: "tok", tools: [] });
    expect(readBridgeConfig(configPath).tools).toEqual([]);
  });

  test("rejects a config without a token — the runtime always writes one", () => {
    writeFileSync(configPath, JSON.stringify({ url: "http://127.0.0.1:9999/call", tools: [] }));
    expect(() => readBridgeConfig(configPath)).toThrow();
  });

  test("rejects a missing config file with a pointer to the session setup", () => {
    expect(() => readBridgeConfig(configPath)).toThrow("config file not found");
  });

  test("rejects invalid JSON", () => {
    writeFileSync(configPath, "not json");
    expect(() => readBridgeConfig(configPath)).toThrow();
  });

  test("rejects tools exceeding maximum", () => {
    const tools = Array.from({ length: 101 }, () => ({
      name: "t",
      description: "d",
      inputSchema: {},
    }));
    writeConfig({ url: "http://127.0.0.1:9999/call", token: "tok", tools });
    expect(() => readBridgeConfig(configPath)).toThrow("exceeds maximum of 100");
  });
});

describe("callBridge", () => {
  /**
   * A fetch fake that records the request and returns the given response.
   */
  function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  const ok: BridgeCallResult = { content: [{ type: "text", text: "done" }], isError: false };

  test("posts the tool call with the bearer token and returns the mapped result", async () => {
    const { calls, fetchFn } = fakeFetch(ok);

    const result = await callBridge({
      url: "http://127.0.0.1:9999/call",
      token: "tok",
      tool: "test_tool",
      params: { a: 1 },
      fetchFn,
    });

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/call");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ tool: "test_tool", args: { a: 1 } });
  });

  test("throws the response text on a non-2xx status", async () => {
    const { fetchFn } = fakeFetch("unknown tool", 404);

    await expect(
      callBridge({ url: "http://x", token: "tok", tool: "test_tool", params: {}, fetchFn }),
    ).rejects.toThrow("bridge 404: unknown tool");
  });

  test("throws the joined text content on an isError result", async () => {
    const { fetchFn } = fakeFetch({
      content: [
        { type: "text", text: "boom" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
      isError: true,
    });

    await expect(
      callBridge({ url: "http://x", token: "tok", tool: "test_tool", params: {}, fetchFn }),
    ).rejects.toThrow("boom\n[image]");
  });

  test("rejects a response that does not match the wire shape", async () => {
    const { fetchFn } = fakeFetch({ content: [{ type: "mystery" }], isError: false });

    await expect(
      callBridge({ url: "http://x", token: "tok", tool: "test_tool", params: {}, fetchFn }),
    ).rejects.toThrow();
  });
});

describe("toAgentResult", () => {
  test("maps text content blocks", () => {
    const result = toAgentResult({
      content: [{ type: "text", text: "hello" }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("maps image content blocks unchanged", () => {
    const result = toAgentResult({
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: "image", data: "base64", mimeType: "image/png" }]);
  });

  test("maps resource blocks to text", () => {
    const result = toAgentResult({
      content: [{ type: "resource", resource: { uri: "file://test.txt", text: "contents" } }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: "text", text: "contents" }]);
  });

  test("maps resource blocks without text to placeholder", () => {
    const result = toAgentResult({
      content: [{ type: "resource", resource: { uri: "file://test.txt" } }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: "text", text: "[resource file://test.txt]" }]);
  });
});
