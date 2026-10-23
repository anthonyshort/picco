---
"@picco-agent/plugin-cron": patch
---

Allow a per-job maximum of simultaneous cron runs, defaulting to one. Skip excess triggers without queuing and preserve active-run accounting across configuration changes.
