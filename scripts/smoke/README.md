# Smoke tests

Smoke tests exercise installed tools and operating-system boundaries that deterministic tests do
not reproduce. They require Linux, bubblewrap, Pi, and a model with tool calling. By default they
use a local OpenAI-compatible model serving `qwen38-27b-nvfp4` at `http://127.0.0.1:8080/v1`.

```bash
pnpm test:smoke:all
```

Set `LLAMA_URL` and `DEFAULT_MODEL` to use another server or model.

To use OpenRouter, set `OPENROUTER_API_KEY` and select a registered Pi model:

```bash
DEFAULT_MODEL=openrouter/deepseek/deepseek-v4.1-flash pnpm test:smoke:all
```

CI runs the full unit and integration suites, then this complete smoke suite against OpenRouter.
Configure `OPENROUTER_API_KEY` as a repository Actions secret. The key is forwarded to sandboxed
Pi workers through their environment. Smoke tests run on main and same-repository PRs; fork PRs
run deterministic checks without the secret.

| Script                  | Coverage                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `test:smoke`            | Pi RPC, multiple turns, process respawn, conversation resume, sandboxing, transcripts and worker shutdown |
| `test:smoke:resources`  | Mounted skill discovery, prompt template expansion and built-in read, write, edit and bash tools          |
| `test:smoke:mcp`        | Deferred native discovery, sandboxed stdio MCP, working directory, environment and subprocess shutdown    |
| `test:smoke:cron`       | Job creation, a background Pi worker, persisted jobs after restart and worker shutdown                    |
| `test:smoke:extensions` | Bundled and unbundled extension loading across local and bubblewrap runtimes                              |

Run an individual script to investigate a failure. The resource, MCP and cron cases use temporary
local fixtures and check file contents, protocol requests or job outcomes. They require no service
accounts beyond the configured model provider.

Smoke tests are separate from `pnpm validate` because they depend on local services and system
packages or hosted model credentials. Deterministic worker, runtime, bridge, and persistence
behaviour remains in `integration/`. That suite also checks a worker dying during a turn, cron
recovery after a failed background worker, and shutdown while workers are active and idle.
