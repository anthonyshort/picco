# Logging

Picco accepts a host-owned logger through `createAgent({ logger })`. The host controls formatting,
levels, destinations, persistence and retention. Picco never flushes or closes it. Without a supplied
logger, Picco uses its existing console formatter.

## Connect a logger

The interface has three methods: `log(event, fields)`, `warning(event, fields)` and
`error(event, fields)`. Adapt the host library's argument order. For Pino:

```ts
import pino from "pino";
import { createAgent, type Logger } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const sink = pino();
const logger: Logger = {
  log: (event, fields) => sink.info(fields, event),
  warning: (event, fields) => sink.warn(fields, event),
  error: (event, fields) => sink.error(fields, event),
};

const agent = createAgent({ name: "assistant", runtime: local(), logger });
```

With Winston, use the same Picco interface and map to `sink.info(event, fields)`,
`sink.warn(event, fields)` and `sink.error(event, fields)` instead. Picco does not depend on either
library. Picco isolates synchronous logger callback failures; the host handles asynchronous
destination errors.

## Capture output

Configure your logger to emit JSON to stdout, then let the launcher capture it:

```sh
node dist/index.js >>server.jsonl 2>>server.stderr.log
```

For a managed service, systemd can capture stdout/stderr in the journal, inspected with
`journalctl -u your-service -o cat`. Docker captures container output through its configured logging
driver. Retention is a host setting; the shell example alone does not bound file size. Picco creates
no per-session operational log files.

## Follow a failure

Events bind the application/component and logical session `{source, key}`. A request ID connects
queueing and execution; a worker ID identifies one spawned Pi process. Native Pi session IDs and
transcript paths appear after a successful state response. Child events add execution and ancestry
IDs, preserving the request that created the child even during a later root turn.

For example, normal idle cleanup produces:

```text
session.idle_expired
worker.stop_requested reason=idle_eviction
worker.exited expected=true signal=SIGTERM stopReason=idle_eviction
```

An unexpected exit records `expected=false` and the affected request. Inspect the service/container
logs when Picco cannot explain the external termination.

A child authentication failure produces `model.failed` and `agent.failed` with the provider/model,
selected failure category and transcript reference. `statusCode=401` means authentication was
rejected; `reason=credentials_expired` requires explicit expiry evidence. An ambiguous OAuth
preflight can report `credentials_unavailable` without claiming the exact cause. A failed attempt
followed by `model.recovered` can still finish the enclosing request successfully.

## Keep content private

Core operational events select IDs, durations, outcomes and known failure codes. They omit prompts,
tool arguments/results, raw provider errors, headers, stacks and worker stderr. Plugins
control any content they explicitly send to their logger.

Native Pi transcripts can contain secrets and full tool output; they are private conversation data,
not sanitised logs. Use their paths when deeper inspection is necessary. See
[Sessions](../concepts/sessions.md#diagnose-failures) for worker lifetime and
[Headless subagents](./headless-subagents.md) for child manifests.
