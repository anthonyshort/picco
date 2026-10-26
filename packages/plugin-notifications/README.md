# `@picco-agent/plugin-notifications`

Send notifications through configured adapters with shared delivery tracking and one agent tool.

## Install

```bash
npm install @picco-agent/core @picco-agent/plugin-notifications @picco-agent/plugin-telegram @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { notifications } from "@picco-agent/plugin-notifications";
import { telegramNotifications } from "@picco-agent/plugin-telegram";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [
    notifications({
      destinations: {
        "review-updates": telegramNotifications({
          botToken: process.env.TELEGRAM_BOT_TOKEN!,
          chatId: Number(process.env.TELEGRAM_CHAT_ID),
        }),
      },
    }),
  ],
});
```

## Docs

- [Send notifications](../../docs/guides/plugins.md#send-notifications)
