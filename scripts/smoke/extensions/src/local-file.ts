/**
 * Local runtime + extension delivered as a FILE PATH (pi.extensions).
 *
 * Node_modules resolution: none. We point pi at the extension's BUNDLED entry (dist/index.js),
 * which has its deps (typebox) inlined at build time. A bundled file is self-contained — it imports
 * nothing from node_modules, so it loads the same everywhere with zero setup. (Point at raw src and
 * you'd be back to needing node_modules; see bwrap-mount.ts.)
 */
import { fileURLToPath } from "node:url";
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { PING_SENTINEL, PING_TOOL } from "@picco-agent/smoke-extension";
import { model, models, runCheck } from "./shared.js";

// The package's "." export is its bundled dist/index.js — resolve it to a file path.
const bundlePath = fileURLToPath(import.meta.resolve("@picco-agent/smoke-extension"));

const agent = createAgent({
  name: "ext-local-file",
  pi: {
    model,
    models,
    extensions: [bundlePath],
  },
  runtime: local(),
});

await runCheck({ label: "local-file", agent, toolName: PING_TOOL, sentinel: PING_SENTINEL });
