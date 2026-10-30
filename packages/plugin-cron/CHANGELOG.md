# @picco-agent/plugin-cron

## 0.2.3

### Patch Changes

- Updated dependencies [a6d3f12]
  - @picco-agent/core@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [c582315]
  - @picco-agent/core@0.3.2

## 0.2.1

### Patch Changes

- @picco-agent/core@0.3.1

## 0.2.0

### Minor Changes

- d774a7c: Add job details and bounded SQLite run history with paginated lookups, live execution correlation and restart interruption recovery. The cron plugin requires Node 22.13 or newer.

### Patch Changes

- dd1c05f: Close each completed cron agent worker before reporting the execution outcome, including failures and timeouts.
- 10eda2f: Add a default reload tool and session reload operation backed by an acknowledged Pi command without inference. Expose Telegram /reload and /reload status, and mark cron workers as one-shot so reload requests return not-needed.
- 4dda0ad: Accept a host logger for Picco and its plugins, and log direct subagent calls, reported models and errors from existing Pi RPC events.
- Updated dependencies [2ace4f6]
- Updated dependencies [10eda2f]
- Updated dependencies [4dda0ad]
  - @picco-agent/core@0.3.0

## 0.1.1

### Patch Changes

- a83cf72: Allow a per-job maximum of simultaneous cron runs, defaulting to one. Skip excess triggers without queuing and preserve active-run accounting across configuration changes.
- Updated dependencies [8e80eaa]
- Updated dependencies [9b9730d]
  - @picco-agent/core@0.2.0
