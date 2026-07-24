# `@picco-agent/plugin-agentmail`

AgentMail mailbox plugin for picco. Provides an inbound email listener and `mail_*` tools (`mail_send`, `mail_reply`, `mail_list`, `mail_search`, `mail_read`, `mail_update`). One allowlist, enforced host-side, gates both directions: who the agent may write to, and whose inbound mail may trigger a turn.

## Install

```bash
npm install @picco-agent/core @picco-agent/plugin-agentmail @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { agentmail } from "@picco-agent/plugin-agentmail";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [
    agentmail({
      apiKey: process.env.AGENTMAIL_API_KEY!,
      inboxId: process.env.AGENTMAIL_INBOX_ID!,
      allowlist: ["you@example.com"],
    }),
  ],
});
```

## Docs

- [Plugins](../../docs/guides/plugins.md)
