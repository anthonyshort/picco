# Agents

`createAgent()` configures the host process that owns sessions, plugins, tools, and a runtime.

## Create an agent

```ts
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
});
```

`name` identifies the agent in logs and scopes its state on disk. `runtime` controls how Pi
processes execute.

Construction validates configuration but does not start processes or listeners.

## Start and stop

```ts
await agent.start();

// Run the assistant until your application shuts down.

await agent.stop();
```

`start()` checks the runtime, creates the data directory, starts session infrastructure, then starts
plugins in declaration order. It handles `SIGINT` and `SIGTERM` by default. Applications that own
signal handling can call `agent.start({ handleSignals: false })`.

`stop()` tears down sessions before stopping plugins in reverse order.

## Run a conversation

```ts
const first = await agent.sessions.run("planning", "Plan this week");
const second = await agent.sessions.run("planning", "Make Wednesday vegetarian");
```

Both turns use the same conversation. Use a different key for an independent conversation.

Session creation can add configuration for that conversation:

```ts
await agent.sessions.run("standup", "What changed overnight?", {
  session: {
    pi: { instructions: "Brief a busy engineer." },
    env: { REPOSITORY: "/srv/checkouts/api" },
    tools: [postToStandup],
  },
});
```

Creation options apply only when the call starts the session. Call `open()` first when your
application needs to make creation explicit.

See [Sessions](../concepts/sessions.md) for queueing, resume, and reset behaviour.

## Stream a turn

`sessions.run()` returns an awaitable turn with a stream of progress events:

```ts
const turn = agent.sessions.run("planning", "Review the backlog");

for await (const event of turn.events) {
  if (event.type === "tool_start") console.log("using", event.tool);
}

const { text } = await turn;
```

Set `timeoutMs` on a turn when work must finish within a fixed period. A timeout fails the turn and
stops its Pi process; the next turn resumes from the persisted transcript.

## Run one-shot work

Use `agent.run()` when work needs a fresh conversation:

```ts
const { text } = await agent.run("Summarise today's server logs.", {
  pi: { model: "anthropic/claude-haiku-4-5" },
  timeoutMs: 120_000,
});
```

Each call creates a session, runs one turn, and stops the process. Plugins can do the same with
`ctx.run()`. Picco limits concurrent one-shot runs to prevent background work from creating
unbounded processes; configure the limit with `sessions.maxRuns` when needed.

## Reclaim idle processes

Sessions stay live by default. Enable idle eviction when a long-running assistant may accumulate
many inactive conversations:

```ts
const agent = createAgent({
  name: "assistant",
  runtime: local(),
  sessions: { idleTimeout: "2h" },
});
```

Eviction stops the process but keeps its working directory and transcript. The next turn resumes
the conversation.
