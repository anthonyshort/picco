# `@picco-agent/bridge-extension`

Pi extension that registers host-side tools via the tool bridge. `@picco-agent/core` installs it
into every session automatically — you never add it yourself.

## How it works

At spawn the runtime writes `bridge.json` (mode 0600) into the session's agent directory: the
bridge URL, a per-session bearer token, and the tool manifest. This extension reads that file,
registers each tool with pi, and forwards calls to the bridge over loopback HTTP.

## Docs

- [Security](../../docs/concepts/security.md#host-side-tools)
