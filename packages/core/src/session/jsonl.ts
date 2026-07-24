/**
 * Maximum line length, in characters (2^20 ≈ 1M). Longer lines are rejected — this also bounds how
 * far the buffer can grow while waiting for a line break.
 */
const MAX_LINE = 1024 * 1024;

/**
 * Shape of a parsed JSONL line.
 */
export type JsonObject = Record<string, unknown>;

/**
 * Parse a stream of newline-delimited JSON objects.
 *
 * Splits on `\n`/`\r` only (not `readline`) to avoid Unicode separator issues (U+2028 / U+2029).
 * Rejects lines exceeding 1 MB. Ends when the stream ends. (ReadableStream is async-iterable in
 * Node ≥20.)
 */
export async function* parseJsonl(stream: ReadableStream<Uint8Array>): AsyncIterable<JsonObject> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let start = 0;
    while (start < buffer.length) {
      const nl = buffer.indexOf("\n", start);
      const cr = buffer.indexOf("\r", start);
      const end = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
      if (end === -1) break;

      if (end - start > MAX_LINE) {
        yield { type: "parse_error", error: `Line exceeds ${MAX_LINE} characters` };
      } else {
        const line = buffer.slice(start, end).trim();
        if (line) yield parseLine(line);
      }
      start = end + 1;
    }
    buffer = buffer.slice(start);

    // Guard unbounded growth while waiting for a line break
    if (buffer.length > MAX_LINE) {
      yield { type: "parse_error", error: `Line exceeds ${MAX_LINE} characters` };
      buffer = "";
    }
  }

  // Remaining data (no trailing newline) — emit as parse error
  const line = buffer.trim();
  if (line.length > 0) {
    yield { type: "parse_error", error: `Incomplete line: ${line.slice(0, 200)}` };
  }
}

/**
 * Serializes JSON objects as newline-terminated JSONL onto a WritableStream.
 */
export class JsonlWriter {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(stream: WritableStream<Uint8Array>) {
    this.writer = stream.getWriter();
    // A write racing process death surfaces as a rejected `closed` promise;
    // without a handler that's an unhandled rejection. Death cleanup happens
    // via the process exit path, so swallowing it here is safe.
    this.writer.closed.catch(() => {});
  }

  /**
   * Write a JSON object terminated by `\n`. Errors are swallowed — the process-exit path owns death
   * handling.
   */
  write(obj: JsonObject): void {
    if (this.closed) return;
    const line = this.encoder.encode(JSON.stringify(obj) + "\n");
    this.writer.write(line).catch(() => {});
  }

  /**
   * Stop writing (the process is dead); later write() calls are dropped.
   */
  markClosed(): void {
    this.closed = true;
  }
}

/**
 * Parse one (non-blank, pre-trimmed) line into an object. Invalid JSON, or valid JSON that isn't a
 * plain object (a number, string, array, or null), becomes a parse_error object — so a JsonObject
 * from this codec is always genuinely an object.
 */
function parseLine(line: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: "parse_error", error: `Invalid JSON: ${line.slice(0, 200)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { type: "parse_error", error: `Expected a JSON object: ${line.slice(0, 200)}` };
  }
  return parsed as JsonObject;
}
