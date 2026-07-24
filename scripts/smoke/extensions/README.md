# Extension smoke tests

These tests load real Pi extensions through the local and bubblewrap runtimes. Each test asks the
configured model to call a fixture tool and verifies its sentinel response.

Run the suite from the repository root:

```bash
pnpm test:smoke:extensions
```

Run one case from this directory with `pnpm smoke:<case>`.

| Case           | Runtime    | Boundary under test                                       |
| -------------- | ---------- | --------------------------------------------------------- |
| `local-file`   | Local      | Bundled file-path extension                               |
| `bwrap-bridge` | Bubblewrap | Bundled host-tool bridge                                  |
| `bwrap-mount`  | Bubblewrap | Unbundled extension with mounted third-party dependencies |

The unbundled case mounts both the fixture's `node_modules` directory and the workspace-level
pnpm package store. The first mount provides the dependency symlink and the second provides its
target. Bundled extensions need neither mount.
