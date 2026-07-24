# Documentation

Picco runs [Pi](https://pi.dev) as a self-hosted assistant or automation. It provides persistent
sessions, plugins, host-side tools, and runtime isolation without replacing Pi's models,
extensions, skills, or packages.

## Start

- [Getting started](./getting-started.md) — install Picco and run a first assistant.

## Understand

- [Architecture](./concepts/architecture.md) — how agents, plugins, runtimes, sessions, and Pi fit
  together.
- [Sessions](./concepts/sessions.md) — conversation identity, queueing, resume, reset, and process
  lifetime.
- [Filesystem](./concepts/filesystem.md) — where session, plugin, and connection data lives.
- [Security](./concepts/security.md) — trust boundaries between the host, runtime, session, and
  external services.

## Build

- [Agents](./guides/agents.md) — create an agent, run conversations, and run one-shot work.
- [Configure Pi](./guides/configuring-pi.md) — choose a model and add instructions or Pi resources.
- [Tools](./guides/tools.md) — expose controlled host-side capabilities.
- [Plugins](./guides/plugins.md) — add gateways, services, commands, and session behaviour.
- [Identity](./guides/identity.md) — connect services using each sender's credentials.
- [Runtimes](./guides/runtimes/index.md) — choose local execution or a bubblewrap sandbox.
- [Providers](./guides/providers.md) — make model credentials and custom providers available.
- [Extensions](./guides/extensions.md) — load Pi extensions from packages or files.
- [Skills](./guides/skills.md) — add procedural knowledge to sessions.
- [MCP servers](./guides/mcp.md) — connect static external MCP services.

For complete signatures and configuration shapes, inspect the exported TypeScript types and source
under [`packages/`](../packages/).
