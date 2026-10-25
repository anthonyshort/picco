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

## Finish execution-owned work

Each submitted turn has a trusted `turn.execution` identity, including while queued.
Bridged tools receive that same identity and a cancellation signal in their context.
Later turns in one conversation have different execution IDs.

A plugin can await critical cleanup using `finaliseExecution`. This is a partial
plugin definition:

```ts
{
  name: "reservations",
  async finaliseExecution({ execution, outcome, signal }) {
    await reservations.finish(execution.id, { outcome, signal });
  },
}
```

Picco waits for admitted host tools and runs finalisers in plugin order before
settling the turn or emitting its final event. Each finaliser has a 30-second
default deadline, configurable with `sessions.finalisationTimeoutMs`. A failed
finaliser does not skip later finalisers. Its session remains quarantined rather
than invoking legacy release hooks or admitting new work under uncertain ownership. `ExecutionFailure` preserves the original
error and separate cleanup errors. Finalisers must honour their signal and retain
uncertain external ownership when their deadline expires.

If host tools cannot settle within the deadline, Picco rejects the execution and
skips release finalisers to quarantine ownership. It cannot retract a submitted
remote write or stop arbitrary JavaScript. Background child integrations must
stop or join their owned work before Pi settles; detached work cannot safely
borrow a later turn's execution identity. Idle or finalising sessions cannot
issue new bridged calls.

## Reload conversation resources

```ts
const session = agent.sessions.get("planning");
if (session) {
  const operation = session.reload();
  await operation.completed;
  console.log(operation.status);
}
```

Reload refreshes Pi's skills, extensions, prompts and instruction files while
preserving the conversation. It uses a registered command, without inference.
A request during a turn is coalesced and runs after critical finalisation, before
the next queued prompt. Inspect `session.reloadStatus()` for the last result.
The default `reload` tool schedules this operation without waiting for its own
turn to finish; `reload({ action: "status" })` inspects its actual result. Telegram
exposes the same operation through `/reload` and `/reload status`.

A session declared `ephemeral: true`, including `agent.run()`, returns
`not-needed`; its worker will close. A closed worker interrupts pending reload.
Resource errors produce a failed result with a safe diagnostic; inspect the
server logs before continuing. Reload does not install packages, change provider
authentication or restart host plugins. Child calls schedule the owning Picco
conversation's reload at its idle boundary, rather than reloading a sibling Pi
process independently.
