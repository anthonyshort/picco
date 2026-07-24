import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The sentinel returned after the bundled smoke fixture loads.
 */
export const PING_SENTINEL = "example-extension-pong";

/**
 * The tool registered by the bundled smoke fixture.
 */
export const PING_TOOL = "example_ping";

/**
 * A minimal Pi extension with one session-side tool.
 *
 * Unlike a bridge tool (which runs on the host), this tool's `execute` runs inside the session — so
 * loading it exercises the extension-discovery path end to end, in whichever runtime hosts the
 * session.
 */
export default function ExampleExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: PING_TOOL,
    label: PING_TOOL,
    description: "Returns a fixed sentinel string. Call this to prove the extension is loaded.",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<undefined>> {
      return {
        content: [{ type: "text", text: PING_SENTINEL }],
        details: undefined,
      };
    },
  });
}
