<div align="center">
  <h1>Picco</h1>
  <p>A small TypeScript framework for building self-hosted assistants and automations on top of Pi.</p>
  <p>
    <a href="docs/getting-started.md">Getting started</a>
    ·
    <a href="docs/index.md">Documentation</a>
    ·
    <a href="docs/guides/plugins.md">Plugins</a>
  </p>
</div>

Picco adds long-lived sessions, plugins, scheduling, and isolated runtimes to
[Pi](https://pi.dev) while leaving the model, tools, skills, and behaviour up to you. Run it on your
own hardware with local or hosted models, and add only the capabilities you need.

## Install

Picco requires Node.js 22.19 or later. Install Pi, Picco, the bubblewrap runtime, and the plugins
used below:

```sh
npm install @earendil-works/pi-coding-agent @picco-agent/core \
  @picco-agent/plugin-cron @picco-agent/plugin-telegram @picco-agent/runtime-bwrap
```

The bubblewrap runtime requires Linux and bubblewrap 0.8 or later.

## Usage

```ts
// assistant.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createAgent } from "@picco-agent/core";
import { cron } from "@picco-agent/plugin-cron";
import { telegram } from "@picco-agent/plugin-telegram";
import { bwrap } from "@picco-agent/runtime-bwrap";

const memoryDirectory = path.resolve("./data/pi-hermes-memory");
mkdirSync(memoryDirectory, { recursive: true });

const agent = createAgent({
  name: "assistant",
  runtime: bwrap({
    env: ["ANTHROPIC_API_KEY"],
    mounts: [
      {
        source: memoryDirectory,
        target: "~/.pi/agent/pi-hermes-memory",
        mode: "rw",
      },
    ],
  }),
  pi: {
    model: "anthropic/claude-sonnet-4-5",
    skills: ["./skills"],
    packages: [
      "npm:context-mode@1.0.169",
      "npm:pi-hermes-memory@0.8.2",
      "npm:@tintinweb/pi-subagents@0.14.2",
      "npm:@tintinweb/pi-tasks@0.7.1",
    ],
  },
  plugins: [
    telegram({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowlist: [Number(process.env.TELEGRAM_CHAT_ID)],
    }),
    cron({ jobDir: "./cron" }),
  ],
});

await agent.start();
```

```sh
ANTHROPIC_API_KEY=... \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
node assistant.mjs
```

This starts an always-on Telegram assistant that can create and run scheduled jobs. Each
conversation runs in a bubblewrap sandbox with Pi extensions, local skills, and persistent Hermes
memory.

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
