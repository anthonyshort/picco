/**
 * Shared runner for the extension-delivery smoke cases.
 */
import type { AgentHandle } from "@picco-agent/core";
import { model, models } from "../../local-model.js";

export { model, models };

/**
 * Drive one turn that asks the model to call `toolName` and echo its result, then assert the
 * `sentinel` came back and the tool fired. Prints PASS/FAIL lines and sets process.exitCode.
 */
export async function runCheck(opts: {
  label: string;
  agent: AgentHandle;
  toolName: string;
  sentinel: string;
}): Promise<void> {
  const { label, agent, toolName, sentinel } = opts;
  try {
    await agent.start({ handleSignals: false });
    console.log(`[${label}] agent started — driving one turn…`);

    const turn = agent.run(
      `Call the ${toolName} tool, then reply with exactly the text it returned and nothing else.`,
      { timeoutMs: 240_000 },
    );
    const { text } = await turn;
    console.log(`[${label}] reply: ${text}`);

    // Replayed post hoc — the finished turn's event stream is complete by now.
    const tools: string[] = [];
    for await (const event of turn.events) {
      if (event.type === "tool_start") tools.push(event.tool);
    }

    const checks: [string, boolean][] = [
      [`extension tool ${toolName} fired`, tools.includes(toolName)],
      ["sentinel round-tripped into the reply", text.includes(sentinel)],
    ];
    for (const [name, ok] of checks) console.log(`[${label}] ${ok ? "PASS" : "FAIL"}: ${name}`);
    process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  } finally {
    await agent.stop();
  }
}
