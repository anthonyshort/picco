# Smoke tests

Smoke tests exercise installed tools and operating-system boundaries that deterministic tests do
not reproduce. They require Linux, bubblewrap, Pi, and a local OpenAI-compatible model serving
`qwen-27b-q6-turbo` at `http://127.0.0.1:8080/v1`.

```bash
pnpm test:smoke:all
```

Set `LLAMA_URL` and `DEFAULT_MODEL` to use another server or model.

| Script                  | Coverage                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `test:smoke`            | Real model, Pi RPC, multiple turns, process respawn, resume, sandboxing, and session files |
| `test:smoke:extensions` | Bundled and unbundled extension loading across local and bubblewrap runtimes               |

Smoke tests are separate from `pnpm validate` because they depend on local services and system
packages. Deterministic worker, runtime, bridge, and persistence behavior remains in `integration/`.
