# @picco-agent/plugin-telegram

## 0.2.0

### Minor Changes

- 10eda2f: Add a default reload tool and session reload operation backed by an acknowledged Pi command without inference. Expose Telegram /reload and /reload status, and mark cron workers as one-shot so reload requests return not-needed.
- 2ace4f6: Move notification delivery into a plugin with named adapters, bounded in-memory deduplication and one notify tool for sending and inspecting receipts. Add a Telegram adapter that sends without starting the conversational gateway. Replace notificationChatId and the Telegram-specific notification tools with configured notification destinations.
- dd1c05f: Add an opt-in telegram_notify tool with a fixed allowlisted recipient for notifications from scheduled and other agent sessions.

### Patch Changes

- Updated dependencies [2ace4f6]
- Updated dependencies [10eda2f]
- Updated dependencies [4dda0ad]
- Updated dependencies [2ace4f6]
  - @picco-agent/core@0.3.0
  - @picco-agent/plugin-notifications@0.2.0

## 0.1.1

### Patch Changes

- 9b9730d: Pass the current session to plugin commands so identity's MCP reconnect command can load tools in an existing conversation.
- Updated dependencies [8e80eaa]
- Updated dependencies [9b9730d]
  - @picco-agent/core@0.2.0
