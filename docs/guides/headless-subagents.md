# Headless subagents

`@picco-agent/headless-subagents` delegates tasks to fresh Pi conversations with native transcripts
and a persistent descendant manifest. It works independently of Picco and shares the parent's workspace and permissions.

## Load the extension

For Pi:

```sh
pi install npm:@picco-agent/headless-subagents
```

For Picco, install `@picco-agent/headless-subagents` beside your application and load it explicitly:

```ts
import { fileURLToPath } from "node:url";
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  dataDir: "./data",
  runtime: local(),
  pi: {
    extensions: [fileURLToPath(import.meta.resolve("@picco-agent/headless-subagents"))],
  },
});

await agent.start();
```

The same extension configuration works with Bubblewrap. The package requires Node 22.19 or later;
Pi provides the SDK and TypeBox at runtime. SDK hosts using a custom `agentDir` must set
`PI_CODING_AGENT_DIR` to the same directory before loading it.

## Delegate a task

The model receives four tools:

| Tool               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `spawn_agent`      | Start a task and return its stable child ID immediately.    |
| `get_agent_result` | Read a child's status and output; set `wait: true` to wait. |
| `stop_agent`       | Cancel a child and its descendants.                         |
| `list_agents`      | Inspect ancestry, status and trace paths.                   |

For example, `spawn_agent` accepts:

```json
{ "prompt": "Inspect the build failure and report its cause", "label": "Build investigation" }
```

Then collect its result with `get_agent_result`:

```json
{ "agentId": "the-returned-id", "wait": true }
```

Children inherit the parent's current model and thinking unless overridden. An explicit model must
match an available `provider/model`; the manifest records both requested and effective settings. Each
child receives the configured instructions and resources without the parent's conversation history.
Load shared tools from file extensions: active inline SDK tools that cannot be recreated cause
startup to fail with their names in the error. Native MCP connections are owned by each session.

## Understand lifetime and limits

Root children survive the spawning call and current parent turn. They stop on task completion,
explicit cancellation or root session shutdown. A nested agent finishing its task cancels its
unfinished descendants. Agents can collect or stop their direct children; the root can inspect the
whole tree. Cancelling a result wait leaves the child running. Completion never starts another
parent turn automatically, so parents must collect results explicitly.

Settings come from `headless-subagents.json` in Pi's agent directory, overridden by the trusted
project's `.pi/headless-subagents.json`. Defaults are:

```json
{
  "maxActive": 4,
  "maxDepth": 3,
  "timeoutMs": 900000,
  "maxTurns": 100
}
```

Capacity includes starting agents across the whole tree; the first child has depth one. Requests
beyond capacity or depth fail immediately. Per-call timeout and turn limits can only tighten these
settings. Results distinguish failure, cancellation, timeout and execution limits, preserving
partial output. Cleanup and storage failures remain visible.

## Inspect a failed child

Call `list_agents` to find the execution manifest and native transcript paths. It returns pages of
up to 25 agents; follow `nextOffset` or open the manifest to inspect the complete current tree.
Follow parent IDs to the failed child, inspect its failure classification, then open its native Pi
transcript for conversation content and private failure details.

Each coordinator start creates a separate execution directory under the root Pi session:

```text
headless-subagents/<root-session-hash>/<execution-id>/
  manifest.json
  agents/<agent-id-hash>/<native-pi-session>.jsonl
```

Set `outputDirectory` to choose another persistent location. Relative paths resolve from the root
working directory. The root transcript records a manifest pointer for each execution. Resuming a Pi
conversation starts a new execution; previous manifests stay available but are not resumed or
rewritten. A historical record marked running describes the last saved state, not current liveness.

The manifest preserves ancestry, outcomes and transcript pointers after shutdown and answer-cache
eviction. Results distinguish execution failures from cleanup or manifest failures. Failure to
forward an optional event does not change a task's outcome. Logs are emitted as versioned Pi events;
the plugin does not write or rotate operational log files.

Files are private, and native transcripts can contain full tasks, tool results and error details.
Operational events select metadata rather than copying message bodies. The manifest is capped at
10,000 agents and 16 MiB; start a new execution when it reaches that limit. File retention belongs to
the host application.
