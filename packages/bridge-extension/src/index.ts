import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import * as z from "zod";

/**
 * The bridge config path: pi's agent directory + bridge.json. Resolved the same way pi resolves its
 * own config dir — `PI_CODING_AGENT_DIR` when set (the runtimes point it at the session dir), else
 * `~/.pi/agent` — so the extension reads the file wherever pi reads its config.
 */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const DEFAULT_CONFIG_PATH = join(AGENT_DIR, "bridge.json");

/**
 * Bridge config the runtime writes into the session's agent directory (`bridge.json`, mode 0600).
 * Every field is machine-written — a partial file is a configuration error, reported loudly.
 */
export const BridgeConfigSchema = z.object({
  // The bridge's /call endpoint.
  url: z.string(),
  // The per-session bearer token value sent on every /call request.
  token: z.string(),
  // Host tools to register with pi.
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100, "bridge extension: config tools exceeds maximum of 100"),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/**
 * One host tool as pi sees it — a deliberate copy of core's SessionToolSpec (this package cannot
 * import core: core bundles this extension, so the dependency points the other way).
 */
export type ToolSpec = BridgeConfig["tools"][number];

/**
 * Response shape of the bridge's POST /call endpoint — a deliberate copy of core's RunToolResult,
 * for the same dependency-direction reason as ToolSpec. Validated on every response so drift
 * between the two copies fails loudly instead of mis-mapping.
 */
export const BridgeCallResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
      z.object({
        type: z.literal("resource"),
        resource: z.object({ uri: z.string(), text: z.string().optional() }),
      }),
    ]),
  ),
  isError: z.boolean(),
});
export type BridgeCallResult = z.infer<typeof BridgeCallResultSchema>;

/**
 * The bridge extension — registers the host-side tools listed in the session's bridge.json.
 */
export default function BridgeExtension(pi: ExtensionAPI) {
  const config = readBridgeConfig(DEFAULT_CONFIG_PATH);

  for (const spec of config.tools) {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: Type.Unsafe(spec.inputSchema),
      execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ): Promise<AgentToolResult<undefined>> {
        return callBridge({
          url: config.url,
          token: config.token,
          tool: spec.name,
          params,
          signal,
        });
      },
    });
  }
}

/**
 * Read and validate the bridge config file.
 */
export function readBridgeConfig(configPath: string): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(
      `bridge extension: config file not found at ${configPath} — ` +
        "is the bridge configured for this session?",
    );
  }
  return BridgeConfigSchema.parse(JSON.parse(raw));
}

/**
 * Execute one host tool over the bridge. Throws the bridge's message on a non-2xx response or an
 * isError result — pi relays a thrown message to the model.
 */
export async function callBridge(opts: {
  url: string;
  token: string;
  tool: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<AgentToolResult<undefined>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(opts.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({ tool: opts.tool, args: opts.params }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`bridge ${res.status}: ${await res.text()}`);
  }

  const body = BridgeCallResultSchema.parse(await res.json());

  if (body.isError) {
    const text = body.content
      .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join("\n");
    throw new Error(text || `${opts.tool} failed`);
  }

  return toAgentResult(body);
}

/**
 * Map a bridge response into the AgentToolResult format pi expects.
 */
export function toAgentResult(body: BridgeCallResult): AgentToolResult<undefined> {
  return {
    content: body.content.map((block) => {
      if (block.type === "image") return block;
      if (block.type === "resource")
        return {
          type: "text" as const,
          text: block.resource.text ?? `[resource ${block.resource.uri}]`,
        };
      return { type: "text" as const, text: block.text };
    }),
    details: undefined,
  };
}
