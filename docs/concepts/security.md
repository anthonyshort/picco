# Security

Picco separates the host process from the Pi session.

```text
host process                         Pi session
------------------------------       -----------------------------
plugins and service clients          model and Pi tools
operator credentials                 skills and extensions
user connection credentials   <---   tool calls with arguments
host-side tool implementations       runtime-visible filesystem
```

## Host-side tools

A Picco tool runs in the host process. The session receives its name, description, and input
schema, then calls it through an authenticated loopback bridge.

Keep operator credentials in the tool's host-side closure. The session sends arguments but does
not receive those credentials. Tool arguments are validated against the tool's Zod schema before
execution.

Each live session receives a bearer token scoped to its identity and session tools. The runtime
writes it to a mode-`0600` `bridge.json` file rather than process arguments. Picco revokes the
token when the session process is released.

## Runtime boundary

`local()` provides no filesystem or process isolation. A session can access everything available
to the host user and inherits the host environment.

`bwrap()` gives each session a private filesystem view and writable home. It shares the host
network, so it is not a network sandbox. Explicit mounts and forwarded environment variables become
visible to every session.

Use `bwrap()` for untrusted prompts and remote gateways. Use `local()` only when host access is
acceptable. See [Runtimes](../guides/runtimes/index.md).

## Model credentials

The model provider runs inside Pi, so its credential must be visible in the session environment.
`local()` inherits host variables. `bwrap()` forwards only the variable names configured in its
`env` option.

## User credentials

The identity plugin stores encrypted user credentials in the host and resolves them for the user
attached to the current turn. Connector tools execute in the host with only their connector's
credential.

Proxy-backed MCP connections use the same host-side credential flow. Provider tokens do not enter
Pi configuration, transcripts, or process arguments. See [Identity](../guides/identity.md).

## Exposed files

Anything in a skill, prompt, extension, session directory, or explicit runtime mount is readable by
session code. Never place credentials in those locations. Prefer read-only mounts and avoid shared
read-write storage when sessions belong to different users.
