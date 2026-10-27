# @picco-agent/core

## 0.3.1

### Patch Changes

- Updated dependencies [1124ac6]
  - @picco-agent/bridge-extension@0.1.3

## 0.3.0

### Minor Changes

- 2ace4f6: Give submitted executions trusted identities, propagate provider failures, and await bounded plugin finalisation before completion. Fence tool admission and quarantine ownership when host work cannot settle safely.
- 10eda2f: Add a default reload tool and session reload operation backed by an acknowledged Pi command without inference. Expose Telegram /reload and /reload status, and mark cron workers as one-shot so reload requests return not-needed.

### Patch Changes

- 4dda0ad: Accept a host logger for Picco and its plugins, and log direct subagent calls, reported models and errors from existing Pi RPC events.
- Updated dependencies [10eda2f]
  - @picco-agent/bridge-extension@0.1.2

## 0.2.0

### Minor Changes

- 8e80eaa: Lazy store factory for connections plugin — pass a function instead of a store instance
- 9b9730d: Support Pi v1 with native MCP server configuration and settled RPC turns. Remove the MCP adapter and use native reconnect commands for per-user connections.

### Patch Changes

- Updated dependencies [9b9730d]
  - @picco-agent/bridge-extension@0.1.1
