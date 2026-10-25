# Extensions

Pi extensions add tools, commands, events, and other behaviour inside a session. Picco supports the
same package and file-path delivery mechanisms as Pi.

## Install a Pi package

Use `packages` for an extension distributed as a Pi package:

```ts
const agent = createAgent({
  name: "assistant",
  runtime: local(),
  pi: {
    packages: ["npm:context-mode@1.0.169"],
  },
});
```

Package entries are Pi source strings such as `npm:`, `git:`, `github:`, or `https:` sources. Pi
installs them into its agent directory when the session starts.

## Load an extension file

Use `extensions` for a local file or directory:

```ts
pi: {
  extensions: ["./extensions/recall.js"],
}
```

Picco resolves the path on the host. `bwrap()` mounts it read-only at the same path inside the
sandbox.

## Make dependencies reachable

A file-path extension may import other packages:

- `local()` uses the host filesystem, so normal Node module resolution applies.
- `bwrap()` cannot see host `node_modules` unless you expose the required directories.
- Pi packages install their own dependencies inside Pi's agent directory.

Bundle a file-path extension when possible. A self-contained bundle behaves consistently across
runtimes and package managers. Use read-only mounts for an unbundled extension whose dependencies
cannot be bundled.

See [bwrap extensions](./runtimes/bwrap.md#load-extensions) for the sandbox configuration.

Everything loaded as an extension executes inside the session's trust boundary. Review third-party
extensions before installing them and do not include host credentials in their files.

## Follow nested subagents

Picco's bundled bridge forwards subagent start/finish events to its existing logs. Each event
includes the child ID, parent ID and root Pi session ID. Finished events also include the
transcript path when available.

This currently requires the included [pi-subagents 0.22.0 patch](../../patches/@tintinweb__pi-subagents@0.22.0.patch).
In a pnpm application that already installs that version, apply it with:

```sh
pnpm patch @tintinweb/pi-subagents@0.22.0 --edit-dir /tmp/pi-subagents
git -C /tmp/pi-subagents apply /absolute/path/to/picco/patches/@tintinweb__pi-subagents@0.22.0.patch
pnpm patch-commit /tmp/pi-subagents
```

Load the patched extension through `pi.extensions` as a local file or bundle. An `npm:` entry
in `pi.packages` installs a separate, unpatched copy.

Picco sets `PI_SUBAGENTS_OUTPUT_DIR` to `<session workspace>/subagent-transcripts`, keeping the
files outside the sandbox's temporary `/tmp`. Open the logged `transcriptPath` to inspect the
conversation and follow `parentAgentId` to its owner. Transcripts contain private prompts, tool
output and errors. The host owns file retention; workflow scripts also use this directory when
enabled.

Start events may have no transcript path yet. Early startup failures, queued cancellations and
crashes do not always produce paired events, and transcript writes remain best-effort.
