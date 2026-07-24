# Identity

The identity plugin lets a person connect their own service account to an assistant. Credentials
are encrypted at rest and resolved in the host for the user attached to the current turn.

Use identity for user-owned credentials. Keep operator-owned credentials in host-side tools.

## Configure connections

```sh
npm install @picco-agent/connectors @picco-agent/core @picco-agent/identity @picco-agent/runtime-local
```

```ts
import { linear } from "@picco-agent/connectors";
import { createAgent } from "@picco-agent/core";
import { connections } from "@picco-agent/identity";
import { fileStore } from "@picco-agent/identity/store";
import { local } from "@picco-agent/runtime-local";

const identity = connections({
  encryptionKey: process.env.CONNECTIONS_KEY!,
  store: fileStore("./data/connections"),
  connectors: [linear()],
});

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [identity],
});
```

Generate the encryption key with `openssl rand -hex 32`. Losing it makes existing connections
unreadable.

Built-in connector factories live in `@picco-agent/connectors`. Use `mcp()` for an OAuth-capable
MCP service or `token()` when users provide a personal token.

## Attach a user

A gateway must attach a stable user identity to every human turn:

```ts
ctx.sessions.run(channelId, message, {
  user: {
    source: "telegram",
    id: "123456789",
    display: "Anthony",
  },
});
```

Use the platform's immutable identifier for `id`. `display` is for logs and user experience, not
authorisation.

The identity plugin uses the user attached to the active turn when a connector tool or MCP proxy
needs a credential.

## Expose connection commands

Identity contributes three commands:

- `/connect <name>` starts or resumes authentication.
- `/connections` lists connected services without revealing credentials.
- `/disconnect <name>` removes a connection.

Gateway plugins decide how commands are presented and dispatch them through `ctx.commands`.
Secret-bearing steps require a private-message callback.

Without a public callback URL, OAuth uses a paste-back flow through
`http://127.0.0.1:8976/oauth/callback`. The user copies the final callback URL back into the private
conversation.

Set `callbackUrl` when a reverse proxy or tunnel can route a public callback to the plugin's
loopback listener:

```ts
connections({
  // ...
  callbackUrl: "https://assistant.example.com/oauth/callback",
});
```

Register that exact URL with each provider.

## Store credentials

`fileStore(directory)` writes encrypted envelopes with restrictive file permissions. Use
`sqliteStore()` from `@picco-agent/identity-sqlite` when SQLite is a better operational fit.

Connector credentials do not enter Pi configuration, transcripts, or process arguments. Connector
tools receive only the credential for their own service.
