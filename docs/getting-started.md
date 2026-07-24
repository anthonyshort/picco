# Getting started

This guide creates a small assistant, runs one prompt, and exits. It uses `local()`, which runs Pi
directly on the host without isolation.

## Install

Picco requires Node.js 22.19 or later. Install the Pi CLI, core, and the local runtime:

```sh
npm install @earendil-works/pi-coding-agent @picco-agent/core @picco-agent/runtime-local
```

## Create the assistant

```ts
// assistant.mjs
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  pi: { model: "anthropic/claude-sonnet-4-5" },
});

await agent.start();

const { text } = await agent.run("Plan three simple dinners for this week.");
console.log(text);

await agent.stop();
```

`agent.run()` creates a fresh session for one turn and removes its process when the turn finishes.
The session directory remains available for inspection.

## Run it

Set the credential used by your selected model and run the file:

```sh
ANTHROPIC_API_KEY=... node assistant.mjs
```

`local()` inherits the host environment and filesystem permissions. Use
[`bwrap()`](./guides/runtimes/bwrap.md) before accepting prompts from an untrusted source.

## Build an always-on assistant

Plugins can receive messages, schedule work, add tools, and shape sessions. Start with
[Agents](./guides/agents.md), then add [plugins](./guides/plugins.md) and choose a
[runtime](./guides/runtimes/index.md).
