# `local()`

`local()` starts each Pi session as an ordinary host process without filesystem or process
isolation.

```ts
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
});
```

Use it for trusted development, personal local use, and platforms where bubblewrap is unavailable.

## Host access

Sessions inherit the host environment, including provider credentials, `HOME`, and `PATH`. They can
read and modify anything available to the host user.

Do not use `local()` for a public gateway or untrusted prompts unless another mechanism provides
the boundary you require.

`ctx.runtime.exec()` also runs directly on the host, inside a temporary working directory.

## Session state

Pi runs with the session directory as its working directory. Picco points
`PI_CODING_AGENT_DIR` at `{session}/.pi/agent` for generated configuration and writes transcripts
directly under the session directory.

The operator's `~/.pi/agent` is not used for session configuration, even though the process retains
the operator's real `HOME`.

## Extensions

File-path extensions use normal host module resolution. Their imports work when dependencies are
reachable from the extension's location.

Bundle extensions intended for distribution. A bundle avoids relying on a particular workspace or
package-manager layout even when the local runtime can see it.
