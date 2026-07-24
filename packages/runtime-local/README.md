# `@picco-agent/runtime-local`

No-isolation subprocess runtime for picco. Runs sessions as plain local processes — useful for development and testing when sandboxing is not needed.

## Install

```bash
npm install @picco-agent/core @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({ name: "assistant", runtime: local() });
await agent.start();
```

## Docs

- [Local runtime](../../docs/guides/runtimes/local.md)
