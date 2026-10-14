import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const secret = readFileSync("secret.txt", "utf8");
connect(Number(process.env.SMOKE_MCP_MONITOR_PORT), "127.0.0.1");
const input = createInterface({ input: process.stdin });

appendFileSync(
  "requests.jsonl",
  JSON.stringify({ method: "started", cwd: process.cwd(), env: process.env.SMOKE_MCP_VALUE }) +
    "\n",
);
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync("requests.jsonl", JSON.stringify(request) + "\n");
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "probe", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "reveal",
            description: "Reveal the probe's secret word with the requested prefix.",
            inputSchema: {
              type: "object",
              properties: { prefix: { type: "string" } },
              required: ["prefix"],
              additionalProperties: false,
            },
          },
        ],
      };
      break;
    case "tools/call":
      if (
        request.params?.name !== "reveal" ||
        typeof request.params.arguments?.prefix !== "string"
      ) {
        result = {
          content: [{ type: "text", text: "Expected reveal with a string prefix" }],
          isError: true,
        };
      } else {
        result = { content: [{ type: "text", text: request.params.arguments.prefix + secret }] };
      }
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
