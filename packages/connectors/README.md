# `@picco-agent/connectors`

Built-in service connectors for `@picco-agent/identity`.

## Install

```bash
npm install @picco-agent/connectors @picco-agent/identity
```

## Usage

```ts
import { linear } from "@picco-agent/connectors";
import { connections } from "@picco-agent/identity";
import { fileStore } from "@picco-agent/identity/store";

const identity = connections({
  encryptionKey: process.env.CONNECTIONS_KEY!,
  store: fileStore("./data/connections"),
  connectors: [linear()],
});
```

## Docs

- [Identity and connections](../../docs/guides/identity.md)
