---
"@picco-agent/plugin-github-reviews": patch
"@picco-agent/core": patch
---

Add durable storage for explicit review jobs, attempts and full results alongside existing polling state. Preserve polling completion history and abandon in-flight executions on restart so fresh attempts can begin without manual reconciliation.
