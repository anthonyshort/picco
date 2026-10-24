# `@picco-agent/headless-subagents`

A regular Pi extension for bounded task delegation with native transcripts, an execution manifest and a complete
parent–child tree. It works independently of Picco.

```sh
pi install npm:@picco-agent/headless-subagents
```

Ask Pi to delegate a task, optionally choosing a model. It uses `spawn_agent`,
`get_agent_result`, `stop_agent` and `list_agents`; results are collected explicitly.

See [Headless subagents](../../docs/guides/headless-subagents.md) for installation in Picco,
execution limits, lifecycle rules and inspecting children.
