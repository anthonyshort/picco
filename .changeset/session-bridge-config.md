---
"@picco-agent/bridge-extension": patch
"@picco-agent/runtime-local": patch
"@picco-agent/runtime-bwrap": patch
---

Store each worker’s Picco connection in `{session}/.picco/bridge.json`, independently of its Pi profile. The bridge extension reads this fixed path from the worker’s working directory without another environment variable.

Upgrade the bridge extension and runtime together. Custom runtimes must write the connection file at the new location with mode `0600`.
