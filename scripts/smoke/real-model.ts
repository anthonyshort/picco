import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { createAgent, tool } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import type { Runtime, RuntimeProcess } from "@picco-agent/core";
import { model, models } from "./local-model.js";

await runSmokeTest();

/**
 * Exercise a real model through Pi, bubblewrap, and a session-process respawn.
 */
async function runSmokeTest(): Promise<void> {
  const agentName = "real-model-smoke";
  const secret = `swordfish-${randomBytes(4).toString("hex")}`;
  const smokeDataDirectory = mkdtempSync(path.join(os.homedir(), ".picco-smoke-"));
  const spawnedProcesses: RuntimeProcess[] = [];
  let toolCalls = 0;

  const magicWord = tool({
    name: "magic_word",
    description: "Returns today's magic word. Call this when asked for the magic word.",
    input: z.object({}),
    execute() {
      toolCalls++;
      console.log(`[real-model] magic_word executed on the host (call ${toolCalls})`);
      return secret;
    },
  });

  const baseRuntime = bwrap();
  const runtime: Runtime = {
    ...baseRuntime,
    async spawn(spec) {
      const spawned = await baseRuntime.spawn(spec);
      spawnedProcesses.push(spawned);
      return spawned;
    },
  };
  const agent = createAgent({
    name: agentName,
    dataDir: smokeDataDirectory,
    pi: { model, models },
    runtime,
    tools: [magicWord],
  });

  try {
    // `|| echo visible` keeps the command's exit code 0 either way — a visible repo must reach
    // the FAIL line below, not crash the script with an exec rejection before any check prints.
    const sandboxResult = await runtime.exec({
      cwd: smokeDataDirectory,
      command: `test ! -e ${process.cwd()}/package.json && echo isolated || echo visible`,
      timeoutMs: 15_000,
    });

    await agent.start({ handleSignals: false });
    console.log("[real-model] agent started, running lifecycle turns");

    const firstTurn = agent.sessions.run(
      "lifecycle",
      "Call the magic_word tool, then reply with exactly the word it returned and nothing else.",
      { timeoutMs: 240_000 },
    );
    const firstResult = await firstTurn;
    const events: string[] = [];
    for await (const event of firstTurn.events) {
      if (event.type === "tool_start") events.push(`tool_start:${event.tool}`);
      if (event.type === "tool_end") events.push(`tool_end:${event.tool}`);
    }

    const secondResult = await agent.sessions.run(
      "lifecycle",
      "Reply with exactly: second-turn-ok",
      { timeoutMs: 240_000 },
    );
    const firstProcess = spawnedProcesses[0]!;
    const reusedFirstProcess = spawnedProcesses.length === 1;

    await firstProcess.kill();
    const resumedResult = await agent.sessions.run(
      "lifecycle",
      "Without calling a tool, reply with exactly the magic word from the first turn.",
      { timeoutMs: 240_000 },
    );

    console.log(`[real-model] first reply: ${firstResult.text}`);
    console.log(`[real-model] second reply: ${secondResult.text}`);
    console.log(`[real-model] resumed reply: ${resumedResult.text}`);

    const sessionDirectory = path.join(
      smokeDataDirectory,
      agentName,
      "sessions",
      "host",
      "lifecycle",
    );
    const checks: [string, boolean][] = [
      ["sandbox cannot read the repository", sandboxResult === "isolated"],
      ["host tool executed over /call", toolCalls > 0],
      ["secret round-tripped into the reply", firstResult.text.includes(secret)],
      ["real tool name in events (not mcp)", events.includes("tool_start:magic_word")],
      ["second turn reused the live Pi process", reusedFirstProcess],
      ["second turn completed", secondResult.text.includes("second-turn-ok")],
      [
        "dead Pi process respawned",
        spawnedProcesses.length === 2 && spawnedProcesses[1] !== firstProcess,
      ],
      ["conversation resumed after respawn", resumedResult.text.includes(secret)],
      [
        "runtime wrote models.json",
        existsSync(path.join(sessionDirectory, ".pi/agent/models.json")),
      ],
      [
        "Pi wrote a session transcript",
        readdirSync(sessionDirectory).some((file) => file.endsWith(".jsonl")),
      ],
    ];
    for (const [label, passed] of checks)
      console.log(`[real-model] ${passed ? "PASS" : "FAIL"}: ${label}`);
    process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;
  } finally {
    await agent.stop();
    rmSync(smokeDataDirectory, { recursive: true, force: true });
  }
}
