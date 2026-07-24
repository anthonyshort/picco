/**
 * Run every runtime and extension-delivery smoke case in its own process.
 *
 * Requires the configured local model. Run one case from this directory with `pnpm smoke:<case>`.
 */
import { spawn } from "node:child_process";

const combos = ["local-file", "bwrap-bridge", "bwrap-mount"];

/**
 * Run one combo's npm script to completion, returning whether it exited 0.
 */
function runCombo(combo: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n─── ${combo} ───`);
    const child = spawn("pnpm", [`smoke:${combo}`], {
      cwd: import.meta.dirname,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

const results: [string, boolean][] = [];
for (const combo of combos) {
  results.push([combo, await runCombo(combo)]);
}

console.log("\n═══ extension smoke summary ═══");
for (const [combo, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${combo}`);

process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
