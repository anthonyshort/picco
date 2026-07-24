# Providers

Pi selects models and resolves their credentials. Picco controls the environment in which Pi runs.

## Use a built-in provider

`local()` inherits the host environment. Set the provider's conventional variable before starting
the agent:

```sh
ANTHROPIC_API_KEY=... node assistant.mjs
```

`bwrap()` starts with a minimal environment. Forward the credential explicitly:

```ts
const agent = createAgent({
  name: "assistant",
  pi: { model: "anthropic/claude-sonnet-4-5" },
  runtime: bwrap({
    env: ["ANTHROPIC_API_KEY"],
  }),
});
```

Every forwarded variable is visible to every session in that runtime. Forward only credentials and
configuration the session needs.

## Add a custom provider

Picco passes `pi.models` to Pi's `models.json` configuration:

```ts
const agent = createAgent({
  name: "assistant",
  pi: {
    model: "local/qwen",
    models: {
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [{ id: "qwen" }],
        },
      },
    },
  },
  runtime: local(),
});
```

Pi requires an authentication value before a custom model becomes available, even when a local
server ignores it. A literal placeholder such as `"local"` is sufficient for that case.

For a real credential, use Pi's environment interpolation and make the variable available through
the runtime:

```ts
// ...
apiKey: "$MY_PROVIDER_KEY",
```

The complete provider schema and supported built-in credentials belong to Pi. Consult
[Pi's model documentation](https://pi.dev) or its installed source for current details.
