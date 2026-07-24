import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const bridgeExtensionDir = path.resolve(__dirname, "../../packages/bridge-extension");

let cachedBundlePath: string | undefined;

/**
 * Absolute path to the bundled bridge extension (`dist/index.js`).
 *
 * The extension is injected into sessions that have no `node_modules`, so its raw source — which
 * imports `zod` and `typebox` — can't be loaded directly. The bundle inlines those deps into one
 * self-contained file, exactly the artifact production ships and pi discovers via `pi.extensions`.
 *
 * Built on demand when missing or stale so the integration suite is self-contained (no manual `pnpm
 * build` step). Cached per worker: at most one build per test process.
 */
export function bridgeExtensionBundle(): string {
  if (cachedBundlePath) return cachedBundlePath;

  const dist = path.join(bridgeExtensionDir, "dist", "index.js");
  const src = path.join(bridgeExtensionDir, "src", "index.ts");
  const stale = !existsSync(dist) || statSync(dist).mtimeMs < statSync(src).mtimeMs;
  if (stale) {
    execFileSync("pnpm", ["build"], { cwd: bridgeExtensionDir, stdio: "ignore" });
  }

  cachedBundlePath = dist;
  return dist;
}
