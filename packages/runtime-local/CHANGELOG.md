# @picco-agent/runtime-local

## 0.2.1

### Patch Changes

- Updated dependencies [c582315]
  - @picco-agent/core@0.3.2

## 0.2.0

### Minor Changes

- 4139ec6: Add an optional agentDir to share an agent-owned Pi profile across workers. Keep worker settings,
  transcripts and bridge credentials session-specific, with shared provider/MCP authentication and
  refresh locks. Reject per-worker model definitions and provider-backed MCP authentication in shared
  mode; configure those in the profile instead.

## 0.1.3

### Patch Changes

- 1124ac6: Store each worker’s Picco connection in `{session}/.picco/bridge.json`, independently of its Pi profile. The bridge extension reads this fixed path from the worker’s working directory without another environment variable.

  Upgrade the bridge extension and runtime together. Custom runtimes must write the connection file at the new location with mode `0600`.

  - @picco-agent/core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [2ace4f6]
- Updated dependencies [10eda2f]
- Updated dependencies [4dda0ad]
  - @picco-agent/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8e80eaa]
- Updated dependencies [9b9730d]
  - @picco-agent/core@0.2.0
