# MCP servers

Use `pi.mcpServers` to make a static external MCP service available to sessions.

```ts
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

Picco writes the configured map to the bundled `pi-mcp-adapter`. The adapter is included in every
session; an empty map simply gives it no servers to connect.

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

The adapter owns MCP transport behaviour. Picco deliberately exposes only the server shape in its
exported `PiOptions` type rather than duplicating the adapter's complete configuration surface.
