# `@picco-agent/plugin-telegram`

Telegram gateway plugin for picco. Maps each chat and thread to an agent session, with typing indicators, progressive replies, and `/new` and `/context` commands.

## Install

```bash
npm install @picco-agent/core @picco-agent/plugin-telegram @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { telegram } from "@picco-agent/plugin-telegram";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [
    telegram({
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      allowlist: [123456789],
    }),
  ],
});
```

## Docs

- [Plugins](../../docs/guides/plugins.md)
