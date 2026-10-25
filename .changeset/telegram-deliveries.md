---
"@picco-agent/plugin-telegram": minor
---

Add process-local notification deduplication and receipt inspection using a bounded lru-cache. Active attempts are reserved separately, completed receipts expire or evict, and plugin restarts discard the cache without replaying sends. Notification tools return structured JSON delivery results.
