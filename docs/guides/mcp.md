# MCP servers

Use `pi.mcpServers` to make an external MCP service available through Pi v1's native MCP support.

```ts
import { createAgent } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  pi: {
    mcpServers: {
      search: { url: "http://127.0.0.1:8080/mcp" },
    },
  },
});
```

Picco writes the server map to each session's native Pi configuration. Pi owns discovery, transport,
and tool execution. Servers use codemode by default. Set `exposure: "direct"` for a small tool set
that should always appear in the model request, or `exposure: "deferred"` to load tools through
Pi's tool search.

## Run a stdio server

Use a command available inside the runtime:

```ts
mcpServers: {
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    exposure: "deferred",
  },
}
```

The server runs inside the same runtime as Pi. With bubblewrap, its executable and files must be
mounted into the sandbox. Relative working directories resolve against the session directory.

## Add static headers

```ts
mcpServers: {
  internal: {
    url: "https://mcp.example.com/mcp",
    headers: { authorization: "Bearer ..." },
  },
}
```

Static headers are visible in session configuration and shared by every session. Use them only when
that exposure and sharing model is acceptable.

For credentials owned by individual users, use an identity
[connector](./identity.md). The identity plugin adds a host-side proxy entry for each configured
service without putting the user's token into the session.

After a user connects, send `/mcp reconnect <name>` through the same session to reconnect the
server and load its tools:

```ts
await ctx.sessions.run(channelId, "/mcp reconnect linear", { user });
```

Pi handles this command without a model turn; the result has empty text. Status notifications go to
Picco's logger. Interactive extension dialogs are cancelled in headless sessions.

`PiOptions.mcpServers` uses Pi's exported `McpServerConfig` type.
