/**
 * An intentionally unbundled extension fixture used by the bwrap mount smoke test.
 *
 * It imports `picocolors` — a real third-party runtime dependency that pi does NOT ship. Loaded as
 * a raw file-path extension under bwrap, this import can only resolve if the workspace node_modules
 * is mounted into the sandbox. (Contrast the bundled entry in ./index.ts, whose deps are inlined.)
 *
 * Typebox resolves for free even without a mount because pi bundles it and exposes its own
 * node_modules to extensions — so we deliberately reach for a package pi has no reason to carry.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import pc from "picocolors";

/**
 * Sentinel proving the un-bundled extension loaded — its third-party import resolved inside the
 * jail.
 */
export const UNBUNDLED_SENTINEL = "unbundled-extension-pong";

/**
 * The tool this variant registers.
 */
export const UNBUNDLED_TOOL = "example_ping_unbundled";

export default function UnbundledExampleExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: UNBUNDLED_TOOL,
    label: UNBUNDLED_TOOL,
    description: "Returns a fixed sentinel string, proving the un-bundled extension loaded.",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<undefined>> {
      // Use picocolors so the dependency is genuinely load-bearing (not erased).
      return {
        content: [{ type: "text", text: pc.reset(UNBUNDLED_SENTINEL) }],
        details: undefined,
      };
    },
  });
}
