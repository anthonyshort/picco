# Working in the smoke suite

Smoke tests cover real process, filesystem, sandbox, Pi, extension, and model boundaries. Keep
`example/` for runnable applications that users can copy; test-only agents and fixtures belong
under `scripts/smoke/`.

## Run the suite

The suite requires Linux, bubblewrap, Pi, and a local OpenAI-compatible model serving
`qwen38-27b-nvfp4` at `http://127.0.0.1:8080/v1`.

```bash
pnpm test:smoke
pnpm test:smoke:extensions
pnpm test:smoke:all
```

Set `LLAMA_URL` and `DEFAULT_MODEL` to test another server or model. Smoke tests stay outside
`pnpm validate` because they require local services and system packages.

## Structure

```text
scripts/smoke/
├── real-model.ts
├── local-model.ts
├── extensions/
│   ├── run.ts
│   ├── src/
│   │   ├── local-file.ts
│   │   ├── bwrap-bridge.ts
│   │   └── bwrap-mount.ts
│   └── package.json
└── fixtures/
    └── example-extension/
        ├── src/index.ts
        ├── src/unbundled.ts
        └── package.json
```

The extension runner and fixture are private pnpm workspaces declared in `pnpm-workspace.yaml`.
The fixture build produces the bundled entry used by `local-file`; its unbundled entry imports
`picocolors` so `bwrap-mount` exercises third-party dependency resolution.

## Real-model lifecycle contract

`real-model.ts` must verify:

- the repository is invisible inside bubblewrap;
- a real Pi RPC worker reaches the configured model;
- a host tool executes through the bridge and emits its real tool events;
- a second turn reuses the live Pi process;
- killing that process causes the next turn to spawn another process;
- the new process resumes the conversation and recalls a random first-turn value;
- the runtime writes `models.json` and Pi writes a transcript.

The test records spawned runtime processes only for lifecycle assertions. It uses a stable
`host/lifecycle` session key and a temporary data directory under the user's home directory. Do not
put the data directory under `/tmp`: bubblewrap mounts a private tmpfs there. Always stop the agent
and remove the temporary directory in `finally`.

## Extension contract

Each extension case runs in a separate child process and verifies both the tool event and its
sentinel response from the real model:

- `local-file`: bundled file-path extension with the local runtime;
- `bwrap-bridge`: bundled host-tool bridge inside bubblewrap;
- `bwrap-mount`: unbundled extension inside bubblewrap with its dependency trees mounted.

The unbundled case needs the fixture's `node_modules` directory for dependency symlinks and the
workspace-level `node_modules` directory for their pnpm package-store targets. Removing either mount
must make the fixture unloadable. Extension cases currently keep their named session data under
`~/.picco/ext-*`.

## Add coverage

- Add a smoke test only when the behavior depends on an installed executable, operating-system
  isolation, package resolution, a real Pi process, or a real model.
- Put deterministic protocol and failure cases in `integration/` with the scripted model server.
- Keep external-account tests such as Telegram, GitHub, OAuth, and hosted providers opt-in. Never
  make normal validation depend on personal credentials or third-party availability.
- Reuse `local-model.ts` instead of repeating provider configuration.
- Assert observable behavior and exit nonzero on failure. Clean up temporary processes and files.

Before committing smoke changes, run:

```bash
pnpm build
pnpm validate
pnpm test:integration
pnpm test:smoke:all
```
