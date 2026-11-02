import { z } from "zod";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const StartedSchema = z.object({
  name: z.literal("atlas.workflow.started"),
  data: z.object({ run_id: z.string().min(1), thread_id: z.string().min(1) }),
});
const RunSchema = z
  .object({
    status: z.string(),
    nodes: z
      .array(
        z
          .object({
            node_id: z.string(),
            status: z.string(),
            iteration: z.number().int(),
            output_json: z.unknown().optional(),
          })
          .passthrough(),
      )
      .max(1000),
  })
  .passthrough();
const STATES = ["running", "complete", "failed", "cancelled"] as const;

/**
 * Host-only Atlas connection. The token never enters agent tools or prompts.
 */
export interface AtlasClientOpts {
  url: string;
  token: string;
  workflow: string;
  fetch?: typeof fetch;
}

/**
 * A dispatch intent whose key has already been saved by the caller.
 */
export interface AtlasLaunchOpts {
  key: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * Atlas run state with the original validated detail for result selection.
 */
export interface AtlasStatus {
  state: (typeof STATES)[number];
  output: z.infer<typeof RunSchema>;
}

/**
 * Create the host HTTP client for one existing Atlas workflow.
 */
export function createAtlasClient(opts: AtlasClientOpts) {
  const fetchResponse = opts.fetch ?? fetch;
  const baseUrl = opts.url.replace(/\/$/, "");

  async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
    try {
      const response = await fetchResponse(`${baseUrl}/api/v1/workflows${path}`, {
        ...init,
        signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${opts.token}`, ...init.headers },
      });
      if (!response.ok) {
        if (response.status === 409 || response.status === 503) {
          let code: string | undefined;
          try {
            const parsed = z
              .object({
                detail: z.object({
                  code: z.enum(["key_reused", "dispatch_in_flight", "dispatch_admission_busy"]),
                }),
              })
              .safeParse(JSON.parse(await readText(response)));
            if (parsed.success) code = parsed.data.detail.code;
          } catch {
            throw new AtlasClientError(
              "Atlas request could not be confirmed",
              true,
              response.status,
            );
          }
          throw new AtlasClientError(
            "Atlas rejected the request",
            code !== "key_reused" && code !== "dispatch_admission_busy",
            response.status,
            code,
          );
        }
        void response.body?.cancel().catch(() => undefined);
        throw new AtlasClientError(
          "Atlas rejected the request",
          response.status >= 500 || response.status === 408 || response.status === 409,
          response.status,
        );
      }
      return response;
    } catch (err) {
      if (err instanceof AtlasClientError) throw err;
      throw new AtlasClientError("Atlas request could not be confirmed", true);
    }
  }

  return {
    async launch(input: AtlasLaunchOpts) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.key)) {
        throw new AtlasClientError("Invalid Atlas dispatch key", false);
      }
      const response = await request(`/${encodeURIComponent(opts.workflow)}/runs`, input.signal, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Idempotency-Key": input.key,
        },
        body: JSON.stringify({ payload: input.payload }),
      });
      return readStarted(response);
    },
    async status(runId: string, signal: AbortSignal): Promise<AtlasStatus> {
      const response = await request(`/runs/${encodeURIComponent(runId)}`, signal);
      try {
        const output = RunSchema.parse(JSON.parse(await readText(response)));
        return { state: resolveState(output.status), output };
      } catch (err) {
        if (err instanceof AtlasClientError) throw err;
        throw new AtlasClientError("Atlas returned an invalid run detail", false);
      }
    },
    async cancel(runId: string, signal: AbortSignal): Promise<void> {
      const response = await request(`/runs/${encodeURIComponent(runId)}/cancel`, signal, {
        method: "POST",
      });
      void response.body?.cancel().catch(() => undefined);
    },
  };
}

/**
 * Sanitised failure. An ambiguous launch must retain its original dispatch key.
 */
export class AtlasClientError extends Error {
  constructor(
    message: string,
    public readonly ambiguous: boolean,
    public readonly statusCode?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AtlasClientError";
  }
}

/**
 * Read bounded UTF-8 chunks and release the detached response on every exit.
 */
async function* readChunks(response: Response) {
  if (!response.body) throw new AtlasClientError("Atlas response has no body", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        yield decoder.decode();
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new AtlasClientError("Atlas response exceeded its size limit", true);
      yield decoder.decode(chunk.value, { stream: true });
    }
  } catch (err) {
    if (err instanceof AtlasClientError) throw err;
    throw new AtlasClientError("Atlas response could not be confirmed", true);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Adopt only the official started event, including chunked and multiline SSE.
 */
async function readStarted(response: Response) {
  let pending = "";
  let event = "";
  let data: string[] = [];
  for await (const chunk of readChunks(response)) {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line === "") {
        if (event === "error") throw new AtlasClientError("Atlas launch returned an error", true);
        if (event === "custom" && data.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.join("\n"));
          } catch {
            throw new AtlasClientError("Atlas returned an invalid launch event", true);
          }
          const started = StartedSchema.safeParse(parsed);
          if (started.success)
            return { runId: started.data.data.run_id, threadId: started.data.data.thread_id };
          const terminal = z
            .object({
              name: z.enum([
                "atlas.workflow.failed",
                "atlas.workflow.cancelled",
                "atlas.workflow.completed",
              ]),
            })
            .safeParse(parsed);
          if (terminal.success)
            throw new AtlasClientError("Atlas launch ended before returning its run", true);
        }
        event = "";
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
      newline = pending.indexOf("\n");
    }
  }
  throw new AtlasClientError("Atlas launch ended before returning its run", true);
}

/**
 * Read JSON bodies under the same transport limit as launch streams.
 */
async function readText(response: Response) {
  let text = "";
  for await (const chunk of readChunks(response)) text += chunk;
  return text;
}

/**
 * Map Atlas's published run statuses without treating unknown states as success.
 */
function resolveState(status: string): AtlasStatus["state"] {
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return "complete";
    case "failed":
    case "error":
    case "interrupted":
    case "expired":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "waiting_for_worker":
    case "running":
    case "waiting_for_input":
    case "waiting_for_timer":
    case "waiting_for_event":
    case "awaiting_connection":
      return "running";
    default:
      throw new AtlasClientError("Atlas returned an unknown run state", false);
  }
}
