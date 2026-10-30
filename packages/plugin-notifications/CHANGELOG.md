# @picco-agent/plugin-notifications

## 0.3.2

### Patch Changes

- Updated dependencies [a6d3f12]
  - @picco-agent/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [c582315]
  - @picco-agent/core@0.3.2

## 0.3.0

### Minor Changes

- 552a03a: Broadcast notifications to host-bound channels and maintain scoped messages with stable keys. Preserve directed sends, isolate per-channel failures, and add optional adapter update support.
- 5e3a62b: Persist scoped notification message handles across restarts. Commit recipient-bound reservations before transport and prevent uncertain or concurrently reserved writes from being replayed automatically.

## 0.2.1

### Patch Changes

- @picco-agent/core@0.3.1

## 0.2.0

### Minor Changes

- 2ace4f6: Move notification delivery into a plugin with named adapters, bounded in-memory deduplication and one notify tool for sending and inspecting receipts. Add a Telegram adapter that sends without starting the conversational gateway. Replace notificationChatId and the Telegram-specific notification tools with configured notification destinations.

### Patch Changes

- Updated dependencies [2ace4f6]
- Updated dependencies [10eda2f]
- Updated dependencies [4dda0ad]
  - @picco-agent/core@0.3.0
