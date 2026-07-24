# `bwrap()`

`bwrap()` starts each Pi session in a separate
[bubblewrap](https://github.com/containers/bubblewrap) sandbox on Linux.

```ts
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";

const agent = createAgent({
  name: "assistant",
  runtime: bwrap(),
});
```

Use it when prompts or in-session code should not receive the host user's filesystem access.

## Requirements

Install bubblewrap 0.8 or later. The `node` and `pi` executables must be available under `/usr`,
which is the system tree mounted inside the sandbox. Toolchains installed only under the host home
directory are not visible.

The runtime checks `bwrap`, `node`, and `pi` during agent startup.

## Filesystem boundary

Each sandbox contains:

- a minimal system tree mounted read-only from `/usr`;
- virtual `/dev` and `/proc`;
- TLS and resolver configuration;
- the session directory as its writable `$HOME`;
- a private `/tmp`;
- configured resources and explicit mounts.

The host home, SSH keys, credentials, unrelated files, and other session directories are hidden by
default.

The network is shared with the host. Bubblewrap limits filesystem and process access; it does not
prevent internet or host-network connections.

## Forward environment variables

The sandbox starts with a minimal environment. Forward variables that Pi or session code needs:

```ts
runtime: bwrap({
  env: ["ANTHROPIC_API_KEY", "SEARXNG_URL"],
});
```

Forwarded values are visible to every session. Model provider credentials must reach Pi; credentials
used only by host-side tools should remain in the host.

## Add filesystem access

Use mounts for reference data, extension state, or other deliberate host access:

```ts
runtime: bwrap({
  mounts: [{ source: "/srv/assistant/reference", target: "/data/reference", mode: "ro" }],
});
```

Prefer read-only mounts. See [Mounts](./bwrap/mounts.md) for persistence and shared-state patterns.

## Load extensions

Pi package sources install their dependencies inside Pi's agent directory:

```ts
pi: {
  packages: ["npm:context-mode@1.0.169"],
}
```

A bundled file-path extension needs no additional configuration because Picco mounts the file
read-only:

```ts
pi: {
  extensions: ["/srv/assistant/extensions/recall.js"],
}
```

An unbundled file may need one or more read-only `node_modules` mounts. Package managers with
non-flat layouts can split a dependency between a symlink tree and a workspace store, so both
locations may be required.

Bundle an extension when possible. See [Extensions](../extensions.md) for the delivery choices.

## Troubleshoot startup

`bwrap: execvp pi: No such file or directory` means the Pi CLI is not on the sandbox `PATH` or is
outside the mounted system tree.

`Cannot find module` while loading an extension means its dependency is not reachable. Bundle the
extension, install it as a Pi package, or mount the required dependency directories read-only.
