# `@picco-agent/plugin-cron`

Cron scheduler plugin for picco. The agent manages YAML job files itself via `cron_*` tools (`cron_list`, `cron_add`, `cron_update`, `cron_remove`, `cron_run`). Jobs run in the agent's configured sandbox.

## Install

```bash
npm install @picco-agent/core @picco-agent/plugin-cron @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { cron } from "@picco-agent/plugin-cron";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [
    cron({
      jobDir: "./cron",
      // Optional: wire run outcomes to your own log or store.
      onRunComplete: (run) => console.log(run.jobId, run.status),
    }),
  ],
});
```

## Docs

- [Plugins](../../docs/guides/plugins.md)
