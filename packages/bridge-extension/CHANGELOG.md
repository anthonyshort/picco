# @picco-agent/bridge-extension

## 0.1.3

### Patch Changes

- 1124ac6: Store each worker’s Picco connection in `{session}/.picco/bridge.json`, independently of its Pi profile. The bridge extension reads this fixed path from the worker’s working directory without another environment variable.

  Upgrade the bridge extension and runtime together. Custom runtimes must write the connection file at the new location with mode `0600`.

## 0.1.2

### Patch Changes

- 10eda2f: Add a default reload tool and session reload operation backed by an acknowledged Pi command without inference. Expose Telegram /reload and /reload status, and mark cron workers as one-shot so reload requests return not-needed.

## 0.1.1

### Patch Changes

- 9b9730d: Support Pi v1 with native MCP server configuration and settled RPC turns. Remove the MCP adapter and use native reconnect commands for per-user connections.
