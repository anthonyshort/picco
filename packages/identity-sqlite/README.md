# `@picco-agent/identity-sqlite`

A SQLite-backed `IdentityStore` for `@picco-agent/identity`.

## Install

```bash
npm install @picco-agent/connectors @picco-agent/identity @picco-agent/identity-sqlite
```

## Usage

```ts
import { DatabaseSync } from "node:sqlite";
import { connections } from "@picco-agent/identity";
import { github } from "@picco-agent/connectors";
import { sqliteStore } from "@picco-agent/identity-sqlite";

const database = new DatabaseSync("connections.db");
const identity = connections({
  encryptionKey: process.env.CONNECTIONS_KEY!,
  store: sqliteStore({
    run: (sql) => database.exec(sql),
    query: (sql) => database.prepare(sql),
  }),
  connectors: [
    github({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
      scopes: ["repo", "read:org"],
    }),
  ],
});
```

The identity plugin encrypts each credential before this store receives it. Any driver matching the
`SqliteLike` shape works.

## Docs

- [Identity and connections](../../docs/guides/identity.md)
