# Tools

A Picco tool is a host-side function that a Pi session can call. Use tools for controlled access to
APIs, data, and host services.

## Create a tool

```ts
import { tool } from "@picco-agent/core";
import * as z from "zod";

const weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => fetchWeather(city, process.env.WEATHER_KEY),
});

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  tools: [weather],
});
```

The Zod object validates arguments before `execute()` runs. Return a concise string for ordinary
results or content blocks for rich content such as images.

Throw an error when execution fails. The model receives the error message and can respond or
recover, so include useful service details without leaking internal stack traces or credentials.

## Keep credentials on the host

`execute()` runs in the host process. The session receives the tool name, description, and input
schema, then calls it through Picco's authenticated bridge.

Keep operator credentials in the tool's closure. Do not add them to the session environment.

## Write descriptions for the model

Tell the model when to use a tool and how it relates to other tools:

```ts
const search = tool({
  name: "sonarr_search",
  description: "Search for a TV series. Call this before sonarr_add and pass the selected tvdbId.",
  input: z.object({ term: z.string() }),
  async execute({ term }) {
    return formatResults(await searchSonarr(term));
  },
});
```

Return only the information needed for the next decision rather than a raw service response.

## Use call context

The second `execute()` argument identifies the caller and, when a gateway attached one, the current
user:

```ts
async execute({ term }, ctx) {
  ctx.logger.log("searching", { term, user: ctx.user?.id });
  // ...
}
```

Ordinary tools never receive connection credentials. Connector tools created through the identity
plugin receive only their connector's resolved token.

## Add a tool to one session

Session tools can close over a conversation-specific destination:

```ts
const reply = tool({
  name: "reply",
  description: "Reply to the current conversation.",
  input: z.object({ text: z.string().min(1) }),
  execute: async ({ text }) => {
    await channel.send(text);
    return "sent";
  },
});

ctx.sessions.run(channel.id, message.text, {
  session: { tools: [reply] },
});
```

Session tools are bound when the session is created and removed when its process is released.

Use an identity [connector](./identity.md) for sender-owned credentials, a [skill](./skills.md) for
instructions that run inside Pi, or an [MCP server](./mcp.md) when an existing service already
provides the tool surface.
