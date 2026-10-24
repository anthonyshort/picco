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
