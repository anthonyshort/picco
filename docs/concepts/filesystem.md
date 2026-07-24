# Filesystem

Picco keeps agent state under `{dataDir}/{agentName}`. `dataDir` defaults to `~/.picco`, and the
required agent name prevents multiple agents from sharing state accidentally.

```text
{dataDir}/{agentName}/
  sessions/
    {source}/{key}/
    host/{generatedId}/
  plugins/
    {pluginName}/
```

## Session directories

Each session directory is Pi's working directory. Both runtimes point
`PI_CODING_AGENT_DIR` at `{session}/.pi/agent` and write generated model, settings, MCP, and bridge
configuration there.

Pi transcripts are written directly under the session directory:

```text
sessions/telegram/123-general/
  .pi/
    agent/
      bridge.json
      settings.json
  2026-07-24T10-15-00-000Z_abc123.jsonl
```

The exact generated files depend on the session configuration. Transcripts and other session files
survive process restarts, idle eviction, and `reset()`. See [Sessions](./sessions.md).

Under `bwrap()`, the session directory is also the sandbox's `$HOME` and only writable
per-session location by default. Under `local()`, Pi uses the directory as its working directory
but retains the operator's real `$HOME`.

## One-shot work

`agent.run()` and `ctx.run()` use generated directories under `sessions/host/`. Their Pi process is
removed after the turn, but the directory remains for inspection.

`ctx.runtime.exec()` also uses a generated workspace, but removes it after the command finishes.

## Plugin data

Each plugin receives a private host directory:

```ts
const path = ctx.filePath("jobs.yaml");
```

This resolves under `plugins/{pluginName}` and is created on first use. Plugin data persists across
restarts and is not visible to sessions unless the plugin or runtime exposes it.

## Connection data

The identity plugin owns its credential storage. Its location depends on the configured store
rather than the core filesystem layout. `fileStore(directory)` writes encrypted credential
files beneath the supplied directory.

## Change the root

```ts
const agent = createAgent({
  name: "assistant",
  dataDir: "/srv/picco",
  runtime: local(),
});
```

This agent stores state under `/srv/picco/assistant`.
