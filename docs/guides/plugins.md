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

| Plugin                                                           | Use                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`plugin-telegram`](../../packages/plugin-telegram/)             | Receive messages and keep one session per chat or topic                      |
| [`plugin-github`](../../packages/plugin-github/)                 | Respond to GitHub mentions or expose standalone PR comment/review tools      |
| [`plugin-github-reviews`](../../packages/plugin-github-reviews/) | Poll personal review requests and run queued reviews                         |
| [`plugin-agentmail`](../../packages/plugin-agentmail/)           | Receive email and expose mailbox tools                                       |
| [`plugin-cron`](../../packages/plugin-cron/)                     | Run scheduled prompts and manage jobs                                        |
| [`plugin-notifications`](../../packages/plugin-notifications/)   | Send notifications through configured adapters and inspect delivery receipts |

The [identity plugin](./identity.md) adds per-user service connections. Combine plugins to build the
assistant you need.

## Use standalone GitHub PR tools

Add outbound PR tools without starting the GitHub mention gateway:

```ts
import { githubTools } from "@picco-agent/plugin-github";

const agent = createAgent({
  // ...
  plugins: [githubTools({ token: () => process.env.GITHUB_TOKEN ?? "" })],
});
```

The agent can call `github_comment` to create or update a conversation comment, `github_inline_comment` to add a diff comment, and `github_review` to submit a comment, approval or changes-requested review with optional inline findings. Credentials remain host-side. The workflow retains returned comment/review IDs; there is no local message store or automatic retry. Inspect GitHub before retrying an uncertain write. Supply the inspected `commitId` for a known revision; an omitted inline commit is resolved from the current head, while an omitted review commit uses GitHub’s latest commit.

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

## Overlapping cron runs

Cron jobs run one at a time by default. Set `maxConcurrentRuns` in a job's YAML,
or through `cron_add` or `cron_update`, when independent executions may overlap:

```yaml
id: requested-reviews
type: agent
description: Review requested pull requests
schedule: "0 */5 * * * *"
enabled: true
prompt: Review the next unclaimed pull request.
maxConcurrentRuns: 3
```

This admits up to three simultaneous runs of that job. Additional timer ticks and
manual triggers are skipped immediately rather than queued. The limit must be an
integer from one to ten. Updating, reloading or removing a job does not cancel
existing runs or release their occupied slots; each run finishes with the
configuration it started with. Independent agent runs receive unique sessions.
Their workers are closed after success, failure or timeout, before completion is
reported. Session files remain available for inspection.

## Inspect scheduled work

The cron plugin provides `cron_list` for a bounded overview and `cron_details` for
one job's current definition, active executions and persisted output/errors:

```text
cron_list({ includeDisabled: true, limit: 20 })
cron_details({ id: "weekly-digest", recentRunsLimit: 10 })
```

The plugin saves run metadata and bounded output in its private `runs.sqlite` database, so history survives restart and job removal. Records left running by the previous process become interrupted because the scheduler cannot prove what completed before it stopped. Capacity skips have separate records and never count as started work.

History keeps up to 1,000 records for at most 30 days, with output capped at 8,192 characters by default. The first limit reached removes old completed records: one run every five minutes fills 1,000 records in about 3.5 days. Configure these bounds with `cron({ history: { maxRecords, retentionDays, maxOutputChars } })`. This is a summary history, so keep full reports or logs in your workflow’s files.

SQLite handles transactions, retention and paginated lookups without rewriting the whole history. One scheduler holds the database lock until its active work stops; a second scheduler cannot open the same file and interrupt its runs. Use the cron tools to inspect history while the scheduler runs. This plugin requires Node 22.13 or newer for the built-in SQLite driver.

The earlier JSON history format was never released. This change uses a new database file and leaves any existing `runs.json` untouched rather than importing or deleting it.

Historical definition snapshots exclude prompt and command bodies. They record
job model overrides when available, rather than guessing inherited runtime model
metadata. Completion follows execution finalisation and ephemeral worker cleanup;
`onRunComplete` observes the saved result and does not own critical cleanup.
A successful run still does not prove a domain action or notification succeeded;
inspect the owning plugin's evidence.

## Send notifications

Use the notifications plugin for unattended updates, such as a completed cron run. Configure named destinations with transport adapters; the agent chooses a destination without supplying a recipient or credentials:

```ts
import { notifications } from "@picco-agent/plugin-notifications";
import { telegramNotifications } from "@picco-agent/plugin-telegram";

const updates = notifications({
  destinations: {
    "review-updates": telegramNotifications({
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      chatId: Number(process.env.TELEGRAM_CHAT_ID),
    }),
  },
});
// Add updates to createAgent({ plugins: [...] }).
```

The Telegram adapter sends to its fixed chat without starting the conversational gateway. Add `telegram(...)` separately if you also want incoming messages and conversation replies. Its chat allowlist controls incoming conversations; notification recipients come from the adapter configuration. Telegram notifications must fit in one plain-text message.

The plugin exposes one `notify` tool for sending and checking receipts:

```typescript
notify({
  action: "send",
  destination: "review-updates",
  text: "Digest ready.",
  deduplicationKey: "digest:2026-10-26",
});
// → { deliveryId, destination, status: "confirmed", externalId: "123", duplicate: false }

notify({ action: "status", deliveryId });
// → the cached receipt without sending another message
```

Reuse a key for the same intent and destination. Concurrent duplicates return the active delivery ID, while reusing a key with different text fails. Keys belong to a destination, so the same key can send through two configured destinations independently. Host code uses `updates.notify(input)` and `updates.delivery(id)` after startup, sharing the tool’s delivery records.

Completed receipts use a bounded `lru-cache`; active attempts have a separate bounded map. Each has a default limit of 10,000 entries, set with `maxDeliveryRecords`. New intents fail at the active-attempt limit instead of removing unfinished reservations, while completed receipts expire or leave the cache when it fills up.

Receipt expiry starts when an attempt completes and defaults to 30 days, set with `deliveryRetentionDays`. Reading a duplicate does not extend that period. Confirmed, rejected and uncertain outcomes all expire or leave the cache, after which the same key can send again. Stopping or restarting the plugin clears these directed-send receipt records without replaying sends. Keyed broadcast handles use separate persistent storage, described below.

A definite rejection differs from uncertain delivery after a timeout or broken connection. Attempts time out after 15 seconds by default, set with `timeoutMs`, and the plugin never retries automatically. Inspect an uncertain result before deliberately sending again. The cache and tool diagnostics exclude message text, credentials and raw provider errors.

### Broadcast and maintain progress messages

Omit `destination` to send to every host-bound channel in one call. A stable `messageKey` creates each message once and updates it when the text changes:

```typescript
notify({ action: "send", messageKey: "progress", text: "Researching the change" });
notify({ action: "send", messageKey: "progress", text: "Verifying findings" });
```

Host code supplies a scope: `updates.notify({ scope: run.id, messageKey: "progress", text })`. The tool derives its scope from the authenticated session, so matching keys in different sessions remain separate. Broadcast results contain a `deliveries` array with an independent receipt for each channel. Unkeyed broadcasts send a new message each time.

For keyed messages, adapters must supply a stable, non-secret `targetId` and return an `externalId` on creation. Implement optional `update(externalId, text, signal)` to edit a message. Changed recipients or unsupported edits are rejected without sending another message. Text reaches each adapter unchanged so the adapter owns platform formatting.

Use `resolveDestinations(scope)` for host-owned per-run routing. It returns the adapters authorised for that scope, for example a fixed chat and the selected PR. Recreate these bindings when the host restarts; the model cannot supply recipients or scope overrides. Directed sends still use the global `destinations` map. Keep run-private recipients out of that map and return them only from `resolveDestinations`.

Edits are serialised per scoped message/channel. Unchanged content causes no write. Uncertain attempts remain blocked for inspection, including when a timed-out adapter finishes later; another channel can still succeed. Message handles are bounded by `maxDeliveryRecords` and are never silently evicted to permit duplicate creation. Keyed handles are stored in the plugin’s `messages.sqlite`, or `messageStorePath` when configured. Confirmed handles survive restarts and later calls update the original messages. Stored state contains recipient identities, provider message IDs and content hashes, not text or credentials. Preserve this database when restarting or moving an agent. Handles are not expired or evicted: at capacity, new messages are refused until the operator deliberately archives or reconciles state.

Each reservation is committed before transport, and concurrent writers cannot both reserve the same prior state. A crash-left reservation reads as uncertain and is not replayed automatically. Uncertain keyed messages stay blocked; this API does not provide a reconciliation command. Inspect provider state before changing keys or editing stored records. The `delivery(deliveryId)` receipt cache is still bounded and process-local; persistence preserves keyed message identity rather than a delivery audit log.

### Add a notification adapter

An adapter sends to a recipient you configure on the host. Implement `NotificationAdapter` to add another transport without registering another agent tool:

```typescript
import type { NotificationAdapter } from "@picco-agent/plugin-notifications";

const adapter: NotificationAdapter = {
  async send(text, signal) {
    const receipt = await client.send({ text, signal });
    return { status: "confirmed", externalId: receipt.id };
  },
};
```

Pass the adapter under a name in `destinations`. Return `rejected` only when you know the provider did not accept the message; throw when the outcome is unknown. Honour the abort signal so timed-out requests stop. The plugin bounds the wait even when an adapter ignores cancellation, but that adapter may still deliver later.

### Move existing Telegram notifications

Replace `telegram({ notificationChatId, ... })` with a `notifications(...)` plugin containing a `telegramNotifications({ botToken, chatId })` destination. Move delivery limits to the notifications plugin, renaming `notificationTimeoutMs` to `timeoutMs`. Replace `telegram_notify` calls with `notify({ action: "send", destination, ... })` and `telegram_delivery` with `notify({ action: "status", deliveryId })`; provider message IDs now use the string `externalId` field.

## Keep asynchronous work inside a turn

Use `observeExecution` when a worker starts work that outlives its initial reply. The hook runs for every execution, so filter `ctx.execution.session.source` when your plugin should only handle a particular session source.

Register a hold synchronously when the worker accepts the work. Complete it when the work finishes, or fail it with its error. Picco keeps the original execution and tool authority until all holds finish and the worker settles. A hold uses the original turn deadline and cancellation signal.

Worker event callbacks must return immediately. Waiting inside them would prevent Picco from reading the event that completes the work. Tool results and custom-message details are `unknown`; validate the fields your plugin recognises.

If a completion message triggers a worker continuation, call `hold.complete({ after: "next-settlement" })`. Picco then waits for a later settlement before returning the final assistant reply. Ordinary host work can use `hold.complete()` without another model turn.

Use `ctx.hold({ name, retireWorker: true })` for detached worker tasks. Picco revokes that worker's token and terminates it before another turn can run on the same session. This prevents stale work from gaining the next execution's authority. Host-only work normally does not need worker retirement. Holds occupy their session's queue; other session keys remain independent.

`finaliseExecution` still runs after tool authority ends. Use it for cleanup, rather than registering work that needs to call host tools.
