# Sessions

A session is one keyed conversation. It has a stable `{source, key}` identity, a working directory,
and a live Pi process while it is active.

## Run turns

```ts
const turn = agent.sessions.run("planning", "Plan this week");
const { text } = await turn;
```

The first turn starts Pi lazily. Later turns with the same key use the same live process and
conversation. Turns within one session run in order; different sessions run concurrently.

Plugins receive a namespaced session API. A Telegram plugin and the host can both use `"planning"`
without sharing a conversation because their sources differ.

## Resume interrupted sessions

The Pi process is disposable; its transcript is not. Picco starts the next process in the same
working directory with `--continue` after:

- idle eviction;
- a failed or crashed turn;
- an agent restart.

The conversation resumes from the latest transcript. Process statistics start again when a process
is recreated.

## Diagnose failures

Picco sends structured lifecycle events to the [host's logger](../guides/logging.md). Follow the
request ID through queueing, model retries, tool calls and completion. Worker IDs change on each
spawn; `{source, key}` identifies the continuing logical conversation. Long requests emit a
30-second progress summary with elapsed time, quiet time and pending-tool count.

`worker.stop_requested` records the reason before signalling. `worker.exited` includes the observed
exit code/signal, stop reason and whether termination was expected. An idle eviction is therefore
distinct from an unexpected SIGTERM during active work. Picco cannot identify an external signal's
sender.

With [headless subagents](../guides/headless-subagents.md), events also identify each descendant and
its originating request, including work finishing after the parent turn. Follow the manifest and
native transcript paths for conversation content. Transcript pointers identify Pi's selected file;
an early failure may occur before that file contains conversation messages. Final shutdown events
may occur after RPC disconnects, so the plugin's lifecycle manifest remains the durable record.

## Start a fresh conversation

```ts
await agent.sessions.reset("planning");
```

`reset()` stops the live process and makes the next turn start without `--continue`. Pi writes a
new transcript beside the previous transcripts. Files in the working directory are not deleted.

Gateway plugins commonly expose this operation as `/new`.

## Choose session identity

Use a stable key when later turns should share context:

```ts
ctx.sessions.run(message.channelId, message.text, { user });
```

Use `agent.run()` or `ctx.run()` for work that needs one fresh turn and no conversation history.
Those calls create a temporary session, run the turn, and stop its process automatically.

Session directories remain on disk in both cases. See [Filesystem](./filesystem.md) for their
layout and [Agents](../guides/agents.md) for the APIs used to run them.
