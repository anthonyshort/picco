# `@picco-agent/identity`

Per-user OAuth and token connections for Picco tools and MCP servers.

## Install

```bash
npm install @picco-agent/connectors @picco-agent/core @picco-agent/identity @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { connections } from "@picco-agent/identity";
import { github } from "@picco-agent/connectors";
import { fileStore } from "@picco-agent/identity/store";
import { local } from "@picco-agent/runtime-local";

const identity = connections({
  encryptionKey: process.env.CONNECTIONS_KEY!,
  store: fileStore("./data/connections"),
  connectors: [
    github({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
      scopes: ["repo", "read:org"],
    }),
  ],
});

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [identity],
});
```

## Docs

- [Identity and connections](../../docs/guides/identity.md)
- [Security](../../docs/concepts/security.md#user-credentials)
