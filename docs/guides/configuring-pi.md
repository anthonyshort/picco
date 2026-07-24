# Configure Pi

The `pi` option provides the base Pi configuration for every session and one-shot run.

```ts
const agent = createAgent({
  name: "assistant",
  runtime: local(),
  pi: {
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
    instructions: "Prefer concise answers.",
  },
});
```

## Choose a model

Model names use Pi's `provider/model-id` form. Pi resolves built-in providers and model
credentials. Picco's runtime controls which environment variables reach the Pi process.

Use [Providers](./providers.md) when you need to forward a credential through `bwrap()` or define a
custom provider.

## Add instructions

`instructions` appends agent-wide rules to Pi's default system prompt:

```ts
pi: {
  instructions: "Never push directly to the main branch.",
}
```

Use `systemPrompt` only when you intend to replace Pi's complete default prompt.

A session can append its own instructions when it is created. Plugins can also adjust instructions
for sessions they own.

## Add Pi resources

```ts
pi: {
  packages: ["npm:context-mode@1.0.169"],
  extensions: ["./extensions/recall.js"],
  skills: ["./skills"],
  prompts: ["./prompts"],
}
```

- `packages` contains Pi package source strings that Pi installs.
- `extensions` contains paths to extension files or directories.
- `skills` contains skill files or directories.
- `prompts` contains prompt-template directories.

Picco resolves paths before starting a session. An isolating runtime makes those paths available
inside its filesystem boundary.

See [Extensions](./extensions.md) for package and dependency choices and [Skills](./skills.md) for
procedural instructions.

## Configure one conversation

Agent-wide configuration is the base. Session creation options merge over it:

```ts
agent.sessions.run("review", "Review this change", {
  session: {
    pi: {
      model: "anthropic/claude-haiku-4-5",
      instructions: "Return only actionable findings.",
    },
  },
});
```

Session instructions append to agent instructions. Other supplied Pi fields replace their
agent-wide value for that session.

Plugins can transform the resolved configuration before a session starts. Use that for
source-specific skills, instructions, or MCP servers.
