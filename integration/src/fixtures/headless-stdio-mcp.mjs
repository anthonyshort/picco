import { connect } from "node:net";
import { createInterface } from "node:readline";

const monitor = connect(Number(process.env.HEADLESS_MCP_MONITOR_PORT), "127.0.0.1");
monitor.write(JSON.stringify({ pid: process.pid }) + "\n");
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "child-cleanup", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo text",
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
      result = { content: [{ type: "text", text: request.params.arguments.text }] };
      break;
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
