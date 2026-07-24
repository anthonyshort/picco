import { createServer, type Server } from "node:http";

const SSE_BASE = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "fake-1" };

/**
 * The first SSE chunk of every completion: the assistant role with no content. Also what a hung
 * response sends before going silent, so the client is mid-stream when it stalls.
 */
const ROLE_PRELUDE = {
  ...SSE_BASE,
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
};

/**
 * A single action the fake model takes for a request: reply text, a tool call, or hang — send the
 * role prelude and leave the stream open until the client aborts (abort-recovery tests).
 */
export type ModelAction =
  | { text: string }
  | { toolCall: { name: string; args: Record<string, unknown> } }
  | { hang: true };

/**
 * The actions that stream back as SSE — a hang never reaches the body builder.
 */
type StreamedAction = Exclude<ModelAction, { hang: true }>;

/**
 * Inbound chat request from the worker to the model endpoint.
 */
export interface ChatRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string; parameters: Record<string, unknown> } }[];
}

/**
 * Script callback: produce actions from the current conversation state.
 */
export type ModelScript = (params: ChatRequest) => ModelAction[];

/**
 * Handle on the fake model server.
 */
export interface FakeModelServer {
  url: string;
  requests: { params: ChatRequest; authorization?: string }[];
  /**
   * Swap the script mid-test — abort tests re-arm the model after killing a hung turn.
   */
  setScript(script: ModelScript): void;
  close(): Promise<void>;
}

/**
 * Start a fake OpenAI-completions endpoint on a random local port. Each POST runs the script
 * against the conversation so far and streams the resulting actions back as SSE.
 */
export async function startFakeModel(script: ModelScript): Promise<FakeModelServer> {
  let current = script;
  const requests: FakeModelServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (chunk: Buffer) => body.push(chunk));
    req.on("end", () => {
      const params = JSON.parse(Buffer.concat(body).toString()) as ChatRequest;
      requests.push({ params, authorization: req.headers.authorization });
      const actions = current(params);
      const streamed = actions.filter((action): action is StreamedAction => !("hang" in action));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streamed.length < actions.length) {
        res.write(`data: ${JSON.stringify(ROLE_PRELUDE)}\n\n`);
        return;
      }
      res.end(sseBody(streamed));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake model server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setScript: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Extract the last tool-result content from a conversation, flattened to text.
 */
export function lastToolText(params: ChatRequest): string {
  const msg = [...params.messages].reverse().find((m) => m.role === "tool");
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  const contents = Array.isArray(msg.content) ? msg.content : [];
  return contents
    .filter((c): c is { text?: string } => typeof c === "object" && c !== null)
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Build an SSE response body from a sequence of streamed actions.
 */
function sseBody(actions: StreamedAction[]): string {
  const chunks: unknown[] = [ROLE_PRELUDE];
  let toolIndex = 0;
  for (const action of actions) {
    if ("text" in action) {
      chunks.push({
        ...SSE_BASE,
        choices: [{ index: 0, delta: { content: action.text }, finish_reason: null }],
      });
    } else {
      chunks.push({
        ...SSE_BASE,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  id: `call_${++toolIndex}`,
                  type: "function",
                  function: {
                    name: action.toolCall.name,
                    arguments: JSON.stringify(action.toolCall.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
  }
  chunks.push({
    ...SSE_BASE,
    choices: [{ index: 0, delta: {}, finish_reason: toolIndex > 0 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}
