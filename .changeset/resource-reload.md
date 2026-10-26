---
"@picco-agent/core": minor
"@picco-agent/bridge-extension": patch
"@picco-agent/plugin-telegram": minor
"@picco-agent/plugin-cron": patch
---

Add a default reload tool and session reload operation backed by an acknowledged Pi command without inference. Expose Telegram /reload and /reload status, and mark cron workers as one-shot so reload requests return not-needed.
