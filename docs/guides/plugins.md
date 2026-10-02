# Plugins

A plugin adds host-side behaviour to an agent. Common plugins provide a message gateway, tools,
commands, background work, or per-session configuration.

## Use a plugin

Pass plugins to `createAgent()`:

```ts
import { telegram } from "@picco-agent/plugin-telegram";

const agent = createAgent({
  // ...
  plugins: [
    telegram({
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      allowlist: [123456789],
    }),
  ],
});
```

Picco includes packages for common assistant surfaces:

| Plugin                                                 | Use                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| [`plugin-telegram`](../../packages/plugin-telegram/)   | Receive messages and keep one session per chat or topic         |
| [`plugin-github`](../../packages/plugin-github/)       | Respond to GitHub mentions with scoped installation credentials |
| [`plugin-agentmail`](../../packages/plugin-agentmail/) | Receive email and expose mailbox tools                          |
| [`plugin-cron`](../../packages/plugin-cron/)           | Run scheduled prompts and manage jobs                           |

The [identity plugin](./identity.md) adds per-user service connections. Combine plugins to build the
assistant you need.

## Create a plugin

Only `name` is required:

```ts
import type { Plugin } from "@picco-agent/core";

export function health(): Plugin {
  return {
    name: "health",
  };
}
```

Names must be unique. A plugin's name scopes its logs, data directory, and sessions.

## Resolve lazy configuration

Use `resolve` when a plugin needs the agent's data directory or name before it can initialise.
The identity plugin uses this hook to support a store factory:

```ts
const identity = connections({
  encryptionKey: process.env.CONNECTIONS_KEY!,
  store: ({ dataDir }) => fileStore(path.join(dataDir, "connections")),
  connectors: [linear()],
});
```

See [Identity](./identity.md) for the complete configuration.

The synchronous `resolve` hook runs once during `createAgent()`, before commands and tools are
collected. Its `dataDir` is the agent root, including the agent name. A thrown error fails agent
construction. Use `start()` for asynchronous setup and long-lived services.

## Add tools

Set `tools` on the plugin to make host-side tools available to every session:

```ts
import { tool, type Plugin } from "@picco-agent/core";
import * as z from "zod";

interface WeatherClient {
  current(city: string): Promise<string>;
}

export function weather(client: WeatherClient): Plugin {
  return {
    name: "weather",
    tools: [
      tool({
        name: "get_weather",
        description: "Get the current weather for a city.",
        input: z.object({ city: z.string() }),
        execute: ({ city }) => client.current(city),
      }),
    ],
  };
}
```

Plugin tools run in the host process, so they can close over clients and credentials without
exposing them to the session. Tool names must be unique across the agent configuration and all
plugins.

See [Tools](./tools.md) for input validation, results, call context, credentials, and
session-specific tools.

## Start a service

Use `start()` and `stop()` for long-lived host resources:

```ts
export function events(client: EventClient): Plugin {
  return {
    name: "events",
    async start(ctx) {
      client.onEvent((event) => {
        void ctx.run(`Summarise this event:\n${event.body}`);
      });
      await client.connect();
    },
    async stop() {
      await client.close();
    },
  };
}
```

`start(ctx)` receives a scoped logger, persistent file paths, namespaced sessions, one-shot work,
runtime command execution, and commands contributed by all plugins.

Close clients, timers, and listeners in `stop()`.

## Build a gateway

A gateway validates an external message, chooses a session key, attaches the sender, and runs a
turn:

```ts
async function handleMessage(ctx: PluginContext, message: Message) {
  if (!allowedChannels.has(message.channelId)) return;

  const { text } = await ctx.sessions.run(message.channelId, message.text, {
    user: {
      source: "chat",
      id: message.userId,
      display: message.displayName,
    },
  });

  await message.reply(text);
}
```

Choose a stable key for the conversation boundary you want. Keys are already namespaced by plugin,
so do not prefix the plugin name.

Apply inbound allowlists before creating a session. Use the platform's immutable user identifier,
not a display name, for authorisation.

## Shape sessions

An owning plugin can prepare files or transform Pi configuration before its sessions start:

```ts
const plugin: Plugin = {
  name: "chat",
  async prepareSession({ cwd }) {
    await writeFile(path.join(cwd, "CONTEXT.md"), "Messages arrive from Chat.");
  },
  configureSession(_session, pi) {
    return {
      ...pi,
      instructions: [pi.instructions, "Keep replies brief."].filter(Boolean).join("\n\n"),
    };
  },
};
```

Use the corresponding `prepareAllSessions` and `configureAllSessions` hooks only when a plugin must
affect sessions owned by other sources. Preparation writes files; configuration returns a new Pi
configuration.

Release session-scoped host state in `releaseSession`. Picco calls release hooks when a process is
reset, evicted, fails, or shuts down.

## Contribute commands

Commands run in the host and are dispatched by gateways:

```ts
const plugin: Plugin = {
  name: "health",
  commands: [
    {
      name: "health",
      description: "Check the assistant",
      handler: async (ctx) => ctx.reply("Healthy"),
    },
  ],
};
```

Use `ctx.commands.list()` to populate a gateway's command menu and `dispatch()` to handle a command.

## Test a plugin

`createFakePluginContext()` records session calls without starting Pi:

```ts
import { createFakePluginContext } from "@picco-agent/core/testing";

const ctx = createFakePluginContext({
  reply: ({ prompt }) => `echo: ${prompt}`,
});

await handleMessage(ctx, message);
expect(ctx.turns[0]).toMatchObject({ key: "channel-1", prompt: "hello" });
```

Keep gateway routing separate from framework event objects so tests can pass small fakes.
