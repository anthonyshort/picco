# Build workflows

A workflow is an async function in your application. It prepares inputs, runs model steps through Picco and saves their results. Your code chooses the order and keeps state between steps. No task registry, slash command or pi-subagents extension is needed.

## Call a workflow directly

After [installing Picco](../getting-started.md), save this as `workflow.ts`. Create a `notes.md` input file and configure `ANTHROPIC_API_KEY` as described in [Providers](./providers.md).

This example uses `local()` for trusted development work. It provides no isolation: Pi and its tools run with the host’s permissions. For isolated model steps, use the Linux [bubblewrap runtime](./runtimes/bwrap.md).

```ts
import { readFile, writeFile } from "node:fs/promises";
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "notes-workflow",
  runtime: local(),
  pi: { model: "anthropic/claude-sonnet-4-5" },
});

async function summariseNotes(file: string) {
  const notes = await readFile(file, "utf8");
  const { text } = await agent.run(`Summarise these notes in plain English:\n${notes}`);
  await writeFile(`${file}.summary.md`, text);
  return text;
}

await agent.start();
try {
  console.log(await summariseNotes("notes.md"));
} finally {
  await agent.stop();
}
```

Run it with `npx tsx workflow.ts`. The application’s file reads and writes run on the host. Only `agent.run()` starts a Pi session through the configured runtime. Each call gets a fresh conversation; pass prior results explicitly when another step needs them.

Use ordinary `await` calls for dependent steps. Independent steps can run together, but the workflow must cancel and await any remaining work if a sibling fails. Picco’s `sessions.maxRuns` limits concurrent one-shot model calls across the application.

## Capture a structured answer

For a model step that returns data, give that run a scoped tool with its original Zod schema. The tool captures the answer in host memory. Read that value after the entire turn finishes, rather than parsing the final assistant text.

Install `zod` and add the following application function to your project. It receives an already started agent:

```ts
import { tool, type AgentHandle } from "@picco-agent/core";
import { z } from "zod";

const AssessmentSchema = z.strictObject({
  summary: z.string().min(1),
  questions: z.array(z.string()).max(10),
});

async function assessNotes(agent: AgentHandle, notes: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let answer: z.infer<typeof AssessmentSchema> | undefined;
  let duplicate = false;
  const output = tool({
    name: "StructuredOutput",
    description: "Return the assessment once, then finish.",
    input: AssessmentSchema,
    execute(value, ctx) {
      ctx.signal?.throwIfAborted();
      if (answer !== undefined) {
        duplicate = true;
        throw new Error("Assessment was returned more than once");
      }
      answer = value;
      return "Assessment received. Finish now.";
    },
  });
  const turn = agent.run(
    `Assess these notes. Call StructuredOutput exactly once, then finish.\n${notes}`,
    { tools: [output], timeoutMs: 120_000 },
  );
  const abort = () => turn.abort("Workflow cancelled");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await turn;
    signal.throwIfAborted();
    if (duplicate) throw new Error("Assessment was returned more than once");
    if (answer === undefined) throw new Error("Assessment was not returned");
    return answer;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
```

Put the assessment schema and function above `agent.start()` in the first example. Replace the contents of its `try` block with:

```ts
const notes = await readFile("notes.md", "utf8");
const signal = AbortSignal.timeout(120_000);
console.log(await assessNotes(agent, notes, signal));
```

Your workflow can pass the returned object to another stage or save it directly.

Picco validates tool arguments before calling `execute`. The duplicate flag also rejects a second result when the model ignores the tool error. A missing answer or failed turn rejects the step; assistant prose does not count as a result.

## Keep session ownership with Picco

`agent.run()` provides the session’s bridge credentials, configured tools, runtime and lifecycle hooks. Session tools are added to agent-wide tools and must have unique names. MCP services remain available through the normal Pi configuration. Use `pi.excludedTools` or your tool policy to restrict a stage’s access; adding one output tool does not restrict the other tools.

Within a plugin, use `ctx.run()` for the same one-shot lifecycle. Its session source is that plugin’s name; `agent.run()` uses `host`. Global session hooks apply to both, while owner-specific hooks apply to the plugin’s own sessions. See [Plugins](./plugins.md) for hook configuration.

## Await cancellation and cleanup

Connect the workflow’s signal to `turn.abort()`, as above, and still await the turn. Picco waits for the process to stop, running host tool calls and required cleanup hooks before the turn settles. Returning as soon as the result tool runs, or racing the turn against cancellation, can let the workflow finish before that cleanup.

Your application also owns any work it starts outside Picco. Cancel it where supported and wait for it to finish before the workflow returns or throws. Use `agent.stop()` when the application shuts down, not after every stage.

## Choose where operations run

Pi’s native tools, such as `read` and `bash`, execute inside the selected runtime. A tool defined with Picco’s `tool()` executes in the host process over the session bridge, even when Pi runs in bubblewrap. Host tools therefore need their own permission checks; the sandbox does not isolate their implementation.

See [Tools](./tools.md) for host capabilities and [GitHub reviews](./github-reviews.md) for a service that calls an application workflow and saves its outcome.
