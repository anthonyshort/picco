---
"@picco-agent/runtime-bwrap": minor
"@picco-agent/runtime-local": minor
---

Add an optional agentDir to share an agent-owned Pi profile across workers. Keep worker settings,
transcripts and bridge credentials session-specific, with shared provider/MCP authentication and
refresh locks. Reject per-worker model definitions and provider-backed MCP authentication in shared
mode; configure those in the profile instead.
