import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgent, type Runtime } from "@picco-agent/core";
import { local } from "@picco-agent/runtime-local";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { lastToolText, startFakeModel } from "../../../integration/src/fake-model.js";

const directory = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(directory, "../..");
const binaryDirectory = path.join(directory, "node_modules/.bin");
const sandboxed = process.argv.includes("--bwrap");
const runtime = sandboxed
  ? bwrap({
      path: `${binaryDirectory}:/usr/local/bin:/usr/bin:/bin`,
      mounts: [
        "node_modules",
        "example/subagent-debugging/node_modules",
        "example/subagent-debugging/dist",
        ...(existsSync("/etc/crypto-policies") ? ["/etc/crypto-policies"] : []),
      ].map((relative) => ({
        source: path.resolve(repository, relative),
        mode: "ro" as const,
      })),
    })
  : local();
const observedRuntime: Runtime = {
  ...runtime,
  spawn: (spec) =>
    runtime.spawn({
      ...spec,
      env: {
        ...spec.env,
        PATH: `${binaryDirectory}:/usr/local/bin:/usr/bin:/bin`,
        PI_SUBAGENTS_OUTPUT_DIR: path.join(spec.cwd, "subagent-transcripts"),
      },
    }),
};
const server = await startFakeModel((request) => {
  if (lastToolText(request)) return [{ text: "Delegated work collected." }];
  const task = JSON.stringify(
    request.messages.filter((message) => message.role === "user").at(-1)?.content,
  );
  if (task.includes("GRANDCHILD_TASK")) return [{ text: "Grandchild transcript is available." }];
  return [
    {
      toolCall: {
        name: "Agent",
        args: {
          subagent_type: "general-purpose",
          prompt: task.includes("CHILD_TASK") ? "GRANDCHILD_TASK" : "CHILD_TASK",
          description: "Inspect delegated task",
          run_in_background: false,
        },
      },
    },
  ];
});
const agent = createAgent({
  name: "subagent-debugging",
  dataDir: path.join(directory, "workspace"),
  runtime: observedRuntime,
  plugins: [
    {
      name: "debugging-fixture",
      prepareAllSessions: ({ cwd }) => {
        const agentDirectory = path.join(cwd, ".pi/agents");
        mkdirSync(agentDirectory, { recursive: true });
        writeFileSync(
          path.join(agentDirectory, "general-purpose.md"),
          [
            "---",
            "name: general-purpose",
            "description: Delegated fixture worker",
            "allowed_subagents: [general-purpose]",
            "---",
            "Complete the delegated task.",
          ].join("\n"),
        );
      },
    },
  ],
  pi: {
    model: "fake/fake-1",
    settings: { compaction: { enabled: false } },
    models: {
      providers: {
        fake: {
          baseUrl: server.url,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "fake-1",
              name: "Fake",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    extensions: [
      path.join(directory, "dist/subagents.js"),
      path.join(directory, "dist/observe-subagents.js"),
    ],
  },
});
try {
  await agent.start({ handleSignals: false });
  await agent.sessions.reset("demo");
  const result = await agent.sessions.run("demo", "ROOT_TASK", { timeoutMs: 30000 });
  console.log(result.text);
} finally {
  await agent.stop();
  await server.close();
}
