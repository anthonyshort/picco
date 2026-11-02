---
"@picco-agent/core": patch
---

Keep failed worker termination handles so cancellation cannot falsely confirm teardown. Retain workers from startup through idle eviction and report failed resets to concurrent callers.
