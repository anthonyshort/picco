# `@picco-agent/core`

AI assistant framework core handling agent sessions, plugins, and tools.

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

const { text } = await agent.run("What can you do?");
console.log(text);
await agent.stop();
```

## Docs

- [Architecture](../../docs/concepts/architecture.md)
- [Agents](../../docs/guides/agents.md)
- [Tools](../../docs/guides/tools.md)
