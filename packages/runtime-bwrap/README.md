# `@picco-agent/runtime-bwrap`

bubblewrap sandbox runtime for picco. Each session runs in an isolated Linux namespace with read-only system mounts and a per-session writable working directory.

## Install

```bash
npm install @picco-agent/core @picco-agent/runtime-bwrap
```

Requires bubblewrap ≥ 0.8 on Linux.

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";

const agent = createAgent({
  name: "assistant",
  runtime: bwrap({
    mounts: ["/home/me/notes", { source: "/some/tree", mode: "ro" }],
  }),
});
```

## Docs

- [Runtimes](../../docs/guides/runtimes/index.md)
- [bubblewrap](../../docs/guides/runtimes/bwrap.md)
- [Mounts](../../docs/guides/runtimes/bwrap/mounts.md)
