---
"@picco-agent/core": patch
"@picco-agent/plugin-cron": patch
"@picco-agent/plugin-agentmail": patch
---

Accept a host logger for Picco and its plugins, and log Pi session models and outcomes through the existing worker stderr stream without patching pi-subagents.
