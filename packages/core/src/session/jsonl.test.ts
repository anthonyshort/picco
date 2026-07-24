import { describe, expect, test } from "vitest";
import { parseJsonl, JsonlWriter, type JsonObject } from "./jsonl.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  for await (const msg of parseJsonl(stream)) out.push(msg);
  return out;
}

describe("parseJsonl (web streams)", () => {
  test("parses newline-delimited objects", async () => {
    const msgs = await collect(streamOf('{"a":1}\n{"b":2}\n'));
    expect(msgs).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("handles objects split across chunks", async () => {
    const msgs = await collect(streamOf('{"type":"resp', 'onse","id":"r1"}\n'));
    expect(msgs).toEqual([{ type: "response", id: "r1" }]);
  });

  test("handles multiple objects in one chunk and CRLF (blank lines skipped)", async () => {
    const msgs = await collect(streamOf('{"a":1}\r\n{"b":2}\r\n'));
    expect(msgs).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("invalid JSON yields parse_error, stream continues", async () => {
    const msgs = await collect(streamOf('not json\n{"ok":true}\n'));
    expect(msgs[0]!.type).toBe("parse_error");
    expect(msgs[1]).toEqual({ ok: true });
  });

  test("incomplete trailing line yields parse_error", async () => {
    const msgs = await collect(streamOf('{"a":1}\n{"trunc'));
    expect(msgs[0]).toEqual({ a: 1 });
    expect(msgs[1]!.type).toBe("parse_error");
    expect(String(msgs[1]!.error)).toContain("Incomplete line");
  });

  test("valid JSON that isn't an object yields parse_error, stream continues", async () => {
    const msgs = await collect(streamOf('42\n[1,2]\n"hi"\nnull\n{"ok":true}\n'));
    expect(msgs.slice(0, 4).map((m) => m.type)).toEqual([
      "parse_error",
      "parse_error",
      "parse_error",
      "parse_error",
    ]);
    expect(msgs[4]).toEqual({ ok: true });
  });

  test("a line over MAX_LINE yields parse_error, later lines still parse", async () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    const msgs = await collect(streamOf(`${huge}\n{"ok":true}\n`));
    expect(msgs[0]!.type).toBe("parse_error");
    expect(String(msgs[0]!.error)).toContain("exceeds");
    expect(msgs[1]).toEqual({ ok: true });
  });

  test("buffer growth past MAX_LINE with no line break yields parse_error", async () => {
    // No newline anywhere — the growth guard must fire rather than buffer unbounded.
    const half = "x".repeat(600 * 1024);
    const msgs = await collect(streamOf(half, half));
    expect(msgs[0]!.type).toBe("parse_error");
    expect(String(msgs[0]!.error)).toContain("exceeds");
  });

  test("multibyte characters split across chunk boundaries survive", async () => {
    const line = JSON.stringify({ text: "héllo — ünïcode" }) + "\n";
    const bytes = new TextEncoder().encode(line);
    // Split in the middle of a multibyte sequence
    const cut = line.indexOf("é") + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const msgs = await collect(stream);
    expect(msgs).toEqual([{ text: "héllo — ünïcode" }]);
  });
});

describe("JsonlWriter", () => {
  test("writes newline-terminated JSON", async () => {
    const written: string[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    });
    const writer = new JsonlWriter(stream);
    writer.write({ type: "prompt", id: "r1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual(['{"type":"prompt","id":"r1"}\n']);
  });

  test("writes after markClosed are dropped", async () => {
    const written: string[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    });
    const writer = new JsonlWriter(stream);
    writer.markClosed();
    writer.write({ a: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([]);
  });
});
