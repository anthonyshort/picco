# Mount files into `bwrap()`

Use `bwrap.mounts` to expose a host path inside every session sandbox.

```ts
runtime: bwrap({
  mounts: [{ source: "/srv/assistant/reference", target: "/data/reference", mode: "ro" }],
});
```

`source` is the host path. `target` is its sandbox path and defaults to `source`. `mode` is `"ro"`
or `"rw"`.

A target beginning with `~/` resolves under the session's `$HOME`.

## Share read-only data

```ts
runtime: bwrap({
  mounts: [{ source: "/srv/assistant/handbook", target: "~/handbook", mode: "ro" }],
});
```

Every session can read the same files without modifying them.

## Persist extension state

Each session directory already survives eviction and restart. Use a read-write mount when multiple
sessions or the host must share data:

```ts
runtime: bwrap({
  mounts: [
    {
      source: "/srv/assistant/memory",
      target: "~/.pi/agent/memory",
      mode: "rw",
    },
  ],
});
```

Mount an extension-owned subdirectory. Do not mount over `~/.pi` or `~/.pi/agent`; those targets
would hide Picco's generated session configuration and the runtime rejects them.

## Mount extension dependencies

An unbundled extension can use read-only dependency mounts:

```ts
runtime: bwrap({
  mounts: [
    { source: "/srv/extensions/recall/node_modules", mode: "ro" },
    { source: "/srv/node_modules", mode: "ro" },
  ],
});
```

Prefer a self-contained bundle when possible. Dependency mounts couple the configuration to the
host package-manager layout.

## Protect shared data

- Prefer read-only mounts.
- Never mount a directory containing credentials.
- Treat every mounted file as visible to untrusted session code.
- Treat a read-write mount as shared mutable state across all sessions.

Use separate paths or another storage design when sessions belong to different users.
