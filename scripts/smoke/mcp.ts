import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { createSmokeModel } from "./model.js";

const RequestSchema = z.object({
  method: z.string(),
  cwd: z.string().optional(),
  env: z.string().optional(),
  params: z
    .object({ name: z.string().optional(), arguments: z.object({ prefix: z.string() }).optional() })
    .optional(),
});

await runMcpSmoke();

/**
 * Discover and invoke a native stdio MCP tool in the sandbox, then verify its child stops.
 */
async function runMcpSmoke(): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.homedir(), ".picco-mcp-smoke-"));
  const secret = `probe-${randomBytes(8).toString("hex")}`;
  const environmentValue = randomBytes(8).toString("hex");
  let serverDirectory = "";
  const disconnected = Promise.withResolvers<void>();
  let monitorConnection: Socket | undefined;
  const monitor = createServer((socket) => {
    monitorConnection = socket;
    socket.on("close", () => disconnected.resolve());
  });
  await new Promise<void>((resolve, reject) => {
    monitor.once("error", reject);
    monitor.listen(0, "127.0.0.1", resolve);
  });
  const address = monitor.address();
  if (!address || typeof address === "string") throw new Error("MCP monitor did not bind");
  const agent = createAgent({
    name: "native-mcp-smoke",
    dataDir,
    runtime: bwrap({ env: ["OPENROUTER_API_KEY"] }),
    pi: {
      ...createSmokeModel(),
      excludedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      mcpServers: {
        probe: {
          command: "node",
          args: ["server.mjs"],
          cwd: "server",
          env: {
            SMOKE_MCP_VALUE: "${SMOKE_MCP_VALUE}",
            SMOKE_MCP_MONITOR_PORT: String(address.port),
          },
          exposure: "deferred",
          description: "A probe service that reveals its secret word.",
        },
      },
    },
    plugins: [
      {
        name: "stdio-fixture",
        prepareAllSessions({ cwd }) {
          serverDirectory = path.join(cwd, "server");
          mkdirSync(serverDirectory, { recursive: true });
          copyFileSync(
            fileURLToPath(new URL("./fixtures/stdio-mcp.mjs", import.meta.url)),
            path.join(serverDirectory, "server.mjs"),
          );
          writeFileSync(path.join(serverDirectory, "secret.txt"), secret);
        },
      },
    ],
  });
  try {
    await agent.start({ handleSignals: false });
    const turn = agent.sessions.run(
      "probe",
      'Discover the probe MCP service and use its tool to reveal its secret word with prefix "smoke-". Reply with exactly the returned text. Do not use filesystem or shell tools.',
      { timeoutMs: 240_000, session: { env: { SMOKE_MCP_VALUE: environmentValue } } },
    );
    const result = await turn;
    const events = [];
    for await (const event of turn.events) events.push(event);
    const requests = readFileSync(path.join(serverDirectory, "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => RequestSchema.parse(JSON.parse(line)));
    const checks: [string, boolean][] = [
      [
        "stdio server started in the relative session cwd",
        requests.some((request) => request.method === "started" && request.cwd === serverDirectory),
      ],
      [
        "stdio server received its interpolated environment",
        requests.some(
          (request) => request.method === "started" && request.env === environmentValue,
        ),
      ],
      [
        "native MCP tool received the requested input",
        requests.some(
          (request) =>
            request.method === "tools/call" &&
            request.params?.name === "reveal" &&
            request.params.arguments?.prefix === "smoke-",
        ),
      ],
      [
        "deferred tool discovery completed successfully",
        events.some(
          (event) => event.type === "tool_end" && event.tool === "tool_search" && !event.isError,
        ),
      ],
      [
        "native MCP tool completed successfully",
        events.some(
          (event) =>
            event.type === "tool_end" && event.tool === "mcp__probe__reveal" && !event.isError,
        ),
      ],
      [
        "fixture-only secret round-tripped through the model",
        result.text.trim() === `smoke-${secret}`,
      ],
      [
        "stdio subprocess stayed alive until shutdown",
        monitorConnection !== undefined && !monitorConnection.destroyed,
      ],
    ];
    await agent.stop();
    const timeout = setTimeout(
      () =>
        disconnected.reject(new Error("MCP subprocess connection remained open after shutdown")),
      2000,
    );
    try {
      await disconnected.promise;
    } finally {
      clearTimeout(timeout);
    }
    checks.push([
      "stdio subprocess exited after agent shutdown",
      monitorConnection !== undefined && monitorConnection.destroyed,
    ]);
    for (const [label, passed] of checks)
      console.log(`[native-mcp] ${passed ? "PASS" : "FAIL"}: ${label}`);
    if (checks.some(([, passed]) => !passed)) {
      console.log(`[native-mcp] reply: ${result.text}`);
      console.log(
        `[native-mcp] protocol methods: ${requests.map((request) => request.method).join(", ")}`,
      );
    }
    process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;
  } finally {
    await agent.stop();
    monitorConnection?.destroy();
    await new Promise<void>((resolve) => monitor.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}
