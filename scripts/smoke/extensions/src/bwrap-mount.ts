/**
 * Bwrap runtime + an UN-BUNDLED file-path extension → the case where YOU must supply node_modules.
 *
 * This is the hard combination the other smoke cases avoid by bundling. Here we point Pi at an
 * un-bundled raw source that does `import pc from "picocolors"` — a real third-party dependency pi
 * does NOT ship and that is NOT inlined. Under bwrap the host filesystem is invisible, so that
 * import can only resolve if we mount the node_modules that contains picocolors into the sandbox.
 * (typebox would resolve for free — Pi bundles it — so the fixture reaches for a package Pi
 * lacks.)
 *
 * Node_modules resolution, and why it takes TWO mounts (this is the crux):
 *
 * Pnpm doesn't put a package's files directly at node_modules/<name>. It uses a symlinked virtual
 * store. Here Node resolves `picocolors` from the extension in two hops:
 *
 *     scripts/smoke/fixtures/example-extension/node_modules/picocolors
 *       → node_modules/.pnpm/picocolors@1.1.1/.../picocolors (the real files, in the store at root)
 *
 * So BOTH trees must be in the sandbox: the package's own node_modules (for the symlink) AND the
 * workspace root node_modules (for the .pnpm store it points at). Mounting only one leaves either a
 * dangling symlink or a missing link.
 *
 * Bundling sidesteps all of this: a self-contained file imports nothing, so it needs no
 * node_modules under any runtime or package manager. Prefer it for anything you ship.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { UNBUNDLED_SENTINEL, UNBUNDLED_TOOL } from "@picco-agent/smoke-extension/unbundled";
import { model, models, runCheck } from "./shared.js";

// The un-bundled raw TypeScript entry (points pi straight at the source file).
const rawEntry = fileURLToPath(import.meta.resolve("@picco-agent/smoke-extension/unbundled"));

// The extension's own node_modules holds the picocolors symlink…
const extNodeModules = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@picco-agent/smoke-extension/package.json"))),
  "node_modules",
);
// …and the workspace root node_modules holds the .pnpm store it points at.
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const rootNodeModules = path.join(repoRoot, "node_modules");

const agent = createAgent({
  name: "ext-bwrap-mount",
  pi: {
    model,
    models,
    extensions: [rawEntry],
  },
  runtime: bwrap({
    // Both mounts make the extension's `import "picocolors"` resolve in the jail.
    // Drop either and the worker dies with `Cannot find module 'picocolors'`.
    mounts: [
      { source: extNodeModules, mode: "ro" },
      { source: rootNodeModules, mode: "ro" },
    ],
  }),
});

await runCheck({
  label: "bwrap-mount",
  agent,
  toolName: UNBUNDLED_TOOL,
  sentinel: UNBUNDLED_SENTINEL,
});
