import { describe, expect, it } from "vitest";
import { AtlasClientError, createAtlasClient } from "./atlas.js";

const signal = new AbortController().signal;
const key = "browser-check-123";

describe("Atlas client", () => {
  it("should send the saved dispatch key and adopt a chunked multiline started event", async () => {
    let request: Request | undefined;
    let cancelled = false;
    const bytes = new TextEncoder().encode(
      ': ready\r\nevent: custom\r\ndata: {"name":"atlas.workflow.started",\r\ndata: "data":{"run_id":"run-🦊","thread_id":"thread-1"}}\r\n\r\n',
    );
    const client = createAtlasClient({
      url: "https://atlas.example/",
      token: "private-token",
      workflow: "Browser check",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });

    await expect(client.launch({ key, payload: { target: "preview" }, signal })).resolves.toEqual({
      runId: "run-🦊",
      threadId: "thread-1",
    });
    expect(request?.url).toBe("https://atlas.example/api/v1/workflows/Browser%20check/runs");
    expect(request?.headers.get("Idempotency-Key")).toBe(key);
    expect(request?.headers.get("Authorization")).toBe("Bearer private-token");
    expect(await request?.json()).toEqual({ payload: { target: "preview" } });
    expect(cancelled).toBe(true);
  });

  it("should keep lost dispatch responses uncertain and hide underlying secrets", async () => {
    const client = createAtlasClient({
      url: "https://atlas.example",
      token: "private-token",
      workflow: "tester",
      fetch: async () => {
        throw new Error("private-token confidential-payload");
      },
    });
    await expect(client.launch({ key, payload: {}, signal })).rejects.toMatchObject({
      name: "AtlasClientError",
      ambiguous: true,
      message: "Atlas request could not be confirmed",
    });
  });

  it.each([
    "event: error\ndata: private-token\n\n",
    "event: custom\ndata: {broken\n\n",
    'event: custom\ndata: {"name":"atlas.workflow.failed"}\n\n',
    "event: end\ndata: {}\n\n",
  ])("should not treat an unconfirmed stream as an accepted run: %s", async (body) => {
    const client = createClient(new Response(body));
    await expect(client.launch({ key, payload: {}, signal })).rejects.toMatchObject({
      ambiguous: true,
    });
  });

  it("should bound launch streams", async () => {
    const client = createClient(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(client.launch({ key, payload: {}, signal })).rejects.toMatchObject({
      message: "Atlas response exceeded its size limit",
      ambiguous: true,
    });
  });

  it.each([
    [403, false],
    [429, false],
    [500, true],
    [408, true],
    [409, true],
  ])("should classify HTTP %i without exposing response text", async (status, ambiguous) => {
    const client = createClient(new Response("private-token confidential-payload", { status }));
    await expect(client.launch({ key, payload: {}, signal })).rejects.toMatchObject({
      statusCode: status,
      ambiguous,
    });
  });

  it.each([
    ["key_reused", 409, false],
    ["dispatch_in_flight", 409, true],
    ["dispatch_admission_busy", 503, false],
  ])("should preserve the safe dispatch refusal code %s", async (code, status, ambiguous) => {
    const client = createClient(Response.json({ detail: { code } }, { status }));
    await expect(client.launch({ key, payload: {}, signal })).rejects.toMatchObject({
      code,
      ambiguous,
      statusCode: status,
    });
  });

  it.each([
    ["completed", "complete"],
    ["succeeded", "complete"],
    ["success", "complete"],
    ["failed", "failed"],
    ["error", "failed"],
    ["interrupted", "failed"],
    ["expired", "failed"],
    ["cancelled", "cancelled"],
    ["queued", "running"],
    ["running", "running"],
    ["waiting_for_worker", "running"],
    ["waiting_for_input", "running"],
    ["waiting_for_timer", "running"],
    ["waiting_for_event", "running"],
    ["awaiting_connection", "running"],
  ])("should map %s to %s and preserve node output", async (status, state) => {
    const detail = {
      status,
      nodes: [
        {
          node_id: "tester",
          status: "succeeded",
          iteration: 0,
          output_json: { observations: ["Verified"] },
        },
      ],
    };
    await expect(createClient(Response.json(detail)).status("run-1", signal)).resolves.toEqual({
      state,
      output: detail,
    });
  });

  it("should reject unknown states and malformed detail without exposing their content", async () => {
    await expect(
      createClient(Response.json({ status: "private-token", nodes: [] })).status("run-1", signal),
    ).rejects.toBeInstanceOf(AtlasClientError);
    await expect(
      createClient(Response.json({ status: "completed" })).status("run-1", signal),
    ).rejects.toMatchObject({ message: "Atlas returned an invalid run detail" });
  });

  it("should cancel by run ID and accept terminal no-ops", async () => {
    let request: Request | undefined;
    const client = createAtlasClient({
      url: "https://atlas.example",
      token: "private-token",
      workflow: "tester",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return Response.json({ status: "completed", noop: "true" });
      },
    });
    await expect(client.cancel("run/1", signal)).resolves.toBeUndefined();
    expect(request?.url).toBe("https://atlas.example/api/v1/workflows/runs/run%2F1/cancel");
    expect(request?.method).toBe("POST");
  });
});

function createClient(response: Response) {
  return createAtlasClient({
    url: "https://atlas.example",
    token: "private-token",
    workflow: "tester",
    fetch: async () => response,
  });
}
