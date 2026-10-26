/**
 * Shared runner for the extension-delivery smoke cases.
 */
import type { AgentHandle } from "@picco-agent/core";
export { createSmokeModel } from "../../model.js";

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
      `Invoke the ${toolName} tool with ${JSON.stringify({ prefix: "smoke-" })}. ` +
        "Make the tool call instead of writing tool-call markup or code. " +
        "Wait for the tool result, then reply with exactly its text content and nothing else.",
      { timeoutMs: 240_000 },
    );
    const { text } = await turn;
    console.log(`[${label}] reply: ${text}`);

    // Replayed post hoc — the finished turn's event stream is complete by now.
    const tools: string[] = [];
    const completedTools: string[] = [];
    for await (const event of turn.events) {
      if (event.type === "tool_start") tools.push(event.tool);
      if (event.type === "tool_end" && !event.isError) completedTools.push(event.tool);
    }

    const checks: [string, boolean][] = [
      [`extension tool ${toolName} fired`, tools.includes(toolName)],
      [`extension tool ${toolName} completed`, completedTools.includes(toolName)],
      ["sentinel round-tripped into the reply", text.includes(sentinel)],
      ["tool input round-tripped into the reply", text.startsWith("smoke-")],
    ];
    for (const [name, ok] of checks) console.log(`[${label}] ${ok ? "PASS" : "FAIL"}: ${name}`);
    process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  } finally {
    await agent.stop();
  }
}
