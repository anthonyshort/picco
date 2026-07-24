# Architecture

A Picco assistant is a TypeScript host process that runs Pi sessions for messages, events, and
direct API calls.

```text
+----------------------- host process ------------------------+
|                                                             |
|  plugins ------> agent ------> runtime                      |
|                    |                                        |
|                    +-- sessions                             |
|                    +-- host-side tools                      |
+--------------------+----------------------------------------+
                     | starts
                     v
+----------------------- session -----------------------------+
|  one Pi process for a live conversation                     |
+-------------------------------------------------------------+
```

## Components

| Component | Owns                                                                            |
| --------- | ------------------------------------------------------------------------------- |
| Agent     | Configuration, plugin lifecycle, sessions, and host-side tools                  |
| Plugin    | A gateway, service, command, tool set, background task, or session behaviour    |
| Runtime   | How Pi processes start and what host resources they can access                  |
| Session   | One keyed conversation, its working directory, and its live Pi process          |
| Pi        | Model interaction, built-in tools, extensions, skills, prompts, and transcripts |

Picco does not replace Pi's ecosystem. Agent-wide Pi configuration is resolved for each session,
then the runtime starts Pi in RPC mode.

## Request flow

```text
plugin or host
      |
      | sessions.run(key, prompt)
      v
session manager -----> runtime -----> Pi process
      |                                  |
      +---------- RPC over stdio <-------+
```

The session manager queues turns with the same key and runs different keys concurrently. The
runtime receives the session directory, Pi configuration, environment, and host-tool manifest. Pi
streams events and the final response back over JSONL RPC.

## Plugins and sessions

Every session has a `source` and `key`. A plugin's name becomes the source for sessions it creates,
so Telegram, GitHub, and host sessions can use the same raw key without colliding.

The owning plugin can prepare files and adjust Pi configuration before its sessions start. Global
plugin hooks can apply to every session. See [Plugins](../guides/plugins.md).

Read [Sessions](./sessions.md) for process and conversation lifetime, [Filesystem](./filesystem.md)
for persisted state, and [Security](./security.md) for trust boundaries.
