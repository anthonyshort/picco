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

After a user connects, they can send `/mcp reconnect <name>` through a gateway that exposes
identity's [connection commands](./identity.md#expose-connection-commands). Host code can also
send the command through the session:

```ts
await ctx.sessions.run(channelId, "/mcp reconnect linear", { user });
```

Pi handles this command without a model turn; the result has empty text. Status notifications go to
Picco's logger. Interactive extension dialogs are cancelled in headless sessions.

`PiOptions.mcpServers` uses Pi's exported `McpServerConfig` type.

## Expose plugin tools to other agents

Declare external tools in a plugin's `mcpTools` and enable the agent's MCP listener:

```ts
import { createAgent, tool, type Plugin } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { z } from "zod";

const status = tool({
  name: "status",
  description: "Read service status",
  input: z.object({}),
  execute: () => JSON.stringify({ ready: true }),
});
const service: Plugin = { name: "service", mcpTools: [status] };
const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [service],
  mcp: { port: 8794, token: process.env.PICCO_MCP_TOKEN! },
});
await agent.start();
```

`Plugin.tools` supplies tools to agent sessions. `Plugin.mcpTools` supplies tools to external MCP
clients. Neither collection is automatically added to the other. To share a tool, include the same
tool object in both arrays. The two collections can also use the same name with different input
schemas and implementations. Duplicate names within either collection fail agent construction.
Session-scoped registrations are not exported.

Configure your client with `http://127.0.0.1:8794/mcp` and an `Authorization: Bearer TOKEN` header
using the same secret. Keep the token in private configuration. The endpoint supports stateless
Streamable HTTP POST requests and rejects browser origins. It starts after plugins and drains
requests before shutdown tears down sessions or plugins.

Each MCP call receives `caller: { kind: "mcp" }` with no session, user or execution identity. Tools
remain responsible for permissions, safe output and any background jobs they start. A disconnected
client does not imply that a side effect was cancelled; job retry and cancellation belong to the
tool's own contract.

`toolTimeoutMs` defaults to five minutes. Tools receive an abort signal and timed-out calls return an
error. Shutdown waits up to 30 seconds (or the configured tool timeout, if shorter). If a tool ignores
cancellation and remains active, shutdown fails and leaves plugins alive rather than claiming that
their work has stopped. Tool timeouts and disconnects do not prove that an external write failed.
