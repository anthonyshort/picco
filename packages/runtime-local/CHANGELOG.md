# @picco-agent/runtime-local

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
