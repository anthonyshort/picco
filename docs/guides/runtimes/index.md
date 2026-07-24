# Runtimes

A runtime starts Pi processes and decides which host resources they can access.

Every agent needs one:

```ts
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
});
```

## Choose a runtime

|             | [`local()`](./local.md)           | [`bwrap()`](./bwrap.md)                 |
| ----------- | --------------------------------- | --------------------------------------- |
| Isolation   | None                              | Linux filesystem and process namespaces |
| Filesystem  | Host user's access                | Session home plus explicit mounts       |
| Environment | Inherits the host                 | Explicit forwarding                     |
| Platform    | Any supported host                | Linux with bubblewrap                   |
| Use for     | Trusted development and local use | Remote or untrusted prompts             |

Both runtimes keep host-side tool and identity credentials outside the Pi process. The difference
is what Pi and its in-session code can access directly.

## Runtime responsibilities

A custom runtime implements Picco's exported `Runtime` interface. It must:

1. Check its external dependencies during agent startup.
2. Write the generated Pi and bridge configuration into the session's agent directory.
3. Start `pi --mode rpc` in the supplied working directory.
4. Make configured skills, prompts, and extensions reachable.
5. Make the host tool bridge reachable without exposing its token in process arguments.
6. Return process streams and lifecycle controls to Picco.
7. Apply an equivalent execution boundary to `runtime.exec()`.

The `SpawnRequest` type is the authoritative contract. `local()` and `bwrap()` are reference
implementations for host and isolated execution.

See [Architecture](../../concepts/architecture.md) for the request flow and
[Security](../../concepts/security.md) for the boundaries a runtime participates in.
