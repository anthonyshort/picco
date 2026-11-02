import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createAgent } from "../../src/agent.js";
import { tool } from "../../src/tools/tool.js";
import { silentLogger } from "../../src/utils/logger.js";
import { FakeRuntime } from "../../src/testing/fake-runtime.js";

const dataDir = z.string().parse(process.argv[2]);
const mode = z.enum(["idle", "blocked"]).parse(process.argv[3]);
let url = "";
const agent = createAgent({
  name: "signal-shutdown",
  dataDir,
  runtime: new FakeRuntime(),
  mcp: { port: 0, token: "signal-test-token", toolTimeoutMs: 1000 },
  logger: {
    ...silentLogger(),
    log(message, data) {
      if (message === "MCP listening") url = z.string().parse(data?.url);
    },
    error(message) {
      console.error(message);
    },
  },
  plugins: [
    {
      name: "shutdown-probe",
      mcpTools: [
        tool({
          name: "hold",
          description: "Hold execution beyond shutdown",
          input: z.object({}),
          execute() {
            process.send?.("tool-entered");
            return new Promise<string>(() => {});
          },
        }),
      ],
      stop() {
        process.send?.("plugin-stopped");
      },
    },
  ],
});

await agent.start();
if (mode === "blocked") {
  const client = new Client({ name: "signal-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: "Bearer signal-test-token" } },
    }),
  );
  void client.callTool({ name: "hold", arguments: {} }).catch(() => {});
} else {
  process.send?.("ready");
}
