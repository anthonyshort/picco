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
