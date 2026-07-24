# picco

Picco is a small TypeScript framework for building self-hosted assistants and automations on top of
[Pi](https://pi.dev).

It adds long-lived sessions, plugins, scheduling, and isolated runtimes while leaving the model,
tools, skills, and behaviour up to you. Run it on your own hardware with local or hosted models,
and add only the capabilities you need.

## Install

Picco requires Node.js 22.19 or later. Install Pi, Picco, and the local runtime:

```sh
npm install @earendil-works/pi-coding-agent @picco-agent/core @picco-agent/runtime-local
```

## Run an assistant

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

```sh
ANTHROPIC_API_KEY=... node assistant.mjs
```

Plugins can turn the same agent into an always-on Telegram assistant, a GitHub bot, an email
assistant, or a scheduled automation. See [Plugins](docs/guides/plugins.md) to add one, or browse
the [documentation](docs/index.md) to build your own setup.

## Features

- **The Pi ecosystem** — use Pi models, extensions, skills, prompts, and packages.
- **Self-hosted** — run on your own hardware with local or hosted models.
- **Persistent sessions** — keep conversations across turns, restarts, and idle eviction.
- **Composable plugins** — add messaging gateways, scheduled work, tools, and session behaviour.
- **Isolated execution** — run sessions directly on the host or inside a bubblewrap sandbox.
- **Host-side credentials** — expose controlled tools without putting their credentials in the
  session.

## Documentation

Start with [Getting started](docs/getting-started.md), or browse the
[documentation index](docs/index.md).

## License

MIT
