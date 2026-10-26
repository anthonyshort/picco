---
"@picco-agent/plugin-notifications": minor
"@picco-agent/plugin-telegram": minor
---

Move notification delivery into a plugin with named adapters, bounded in-memory deduplication and one notify tool for sending and inspecting receipts. Add a Telegram adapter that sends without starting the conversational gateway. Replace notificationChatId and the Telegram-specific notification tools with configured notification destinations.
