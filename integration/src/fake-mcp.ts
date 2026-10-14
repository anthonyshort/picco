import { createServer } from "node:http";
import { z } from "zod";

/**
 * Requests used by the fixture's initialise and echo operations.
 */
const McpRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({
      protocolVersion: z.string().optional(),
      arguments: z.object({ text: z.string() }).optional(),
    })
    .optional(),
});

/**
 * A stateless MCP HTTP server with one echo tool and recorded upstream credentials.
 */
export interface FakeMcpServer {
  url: string;
  requests: { method: string; authorization?: string }[];
  close(): Promise<void>;
}

/**
 * Start a local MCP endpoint for real worker and credential-proxy integration tests.
 */
export async function startFakeMcp(): Promise<FakeMcpServer> {
  const requests: FakeMcpServer["requests"] = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body: Buffer[] = [];
    req.on("data", (chunk: Buffer) => body.push(chunk));
    req.on("end", () => {
      const message = McpRequestSchema.parse(JSON.parse(Buffer.concat(body).toString()));
      requests.push({ method: message.method, authorization: req.headers.authorization });
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "probe", version: "1.0.0" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: "Echo the supplied text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          };
          break;
        case "tools/call":
          result = {
            content: [{ type: "text", text: `MCP echo: ${message.params?.arguments?.text}` }],
          };
          break;
        case "ping":
          result = {};
          break;
        default:
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
          return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP server address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
