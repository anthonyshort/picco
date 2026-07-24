---
name: add-core-extension
description: Add a new extension that will be bundled with core, like the tool bridge.
---

### Adding another core extension

To ship a new extension bundled with core — loaded in every session automatically, like the bridge:

1. **Create the package** `packages/<name>/` in the shape above: `src/index.ts` registering its
   tools, a `build` + `prepare` script that bundles to `dist/index.js` with only the pi SDK marked
   external, `files: ["dist/"]`, and `pi: { extensions: ["./dist/index.js"] }`. Read any per-session
   configuration from a file the runtime writes, not from imports.
2. **Add it as a dependency of `@picco-agent/core`** (`"@picco-agent/<name>": "workspace:*"`), so
   `resolveBundledPackage` finds it from core's own dependencies.
3. **Register it** in core's `BUNDLED_EXTENSIONS` list (in `agent.ts`) — one line. Core resolves its
   bundle and injects it into `pi.extensions` for every session.
4. **`pnpm install`** — the package's `prepare` builds `dist/`, so it's present with no manual step.

That's the whole process: a bundled package, one dependency entry, one line in the list.
