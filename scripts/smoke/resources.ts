import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { createSmokeModel } from "./model.js";

await runSmokeTest();

/**
 * Exercise mounted skills, prompt expansion and built-in file tools through a real sandboxed Pi.
 */
async function runSmokeTest(): Promise<void> {
  const dataDirectory = mkdtempSync(path.join(os.homedir(), ".picco-resources-smoke-"));
  const skillDirectory = path.join(dataDirectory, "fixtures", "resource-probe");
  const promptDirectory = path.join(dataDirectory, "fixtures", "prompts");
  const skillSecret = `resource-${randomBytes(8).toString("hex")}`;
  const promptSecret = `template-${randomBytes(8).toString("hex")}`;
  const agentName = "resources-smoke";
  const agent = createAgent({
    name: agentName,
    dataDir: dataDirectory,
    runtime: bwrap({ env: ["OPENROUTER_API_KEY"] }),
    pi: {
      ...createSmokeModel(),
      skills: [skillDirectory],
      prompts: [promptDirectory],
      allowedTools: ["read", "write", "edit", "bash"],
    },
  });

  try {
    mkdirSync(skillDirectory, { recursive: true });
    mkdirSync(promptDirectory, { recursive: true });
    writeFileSync(
      path.join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: resource-probe",
        "description: Complete the resource probe using the built-in file tools. Use when asked to run the resource probe.",
        "---",
        "Complete these steps in order, using each named tool:",
        `1. Use write to create resource.txt in the working directory containing exactly draft:${skillSecret}`,
        "2. Use edit to replace draft: with final: in resource.txt.",
        "3. Use bash to run: cp resource.txt copied.txt",
        "4. Use read to read copied.txt.",
        "5. Reply with exactly the contents of copied.txt and nothing else.",
      ].join("\n"),
    );
    writeFileSync(
      path.join(promptDirectory, "resource-template.md"),
      [
        "---",
        "description: Return the resource template marker and two arguments.",
        "---",
        `Reply with exactly this text and nothing else: ${promptSecret}:$1:$2`,
      ].join("\n"),
    );

    await agent.start({ handleSignals: false });
    console.log("[resources] agent started, running skill and prompt turns");

    const turn = agent.sessions.run(
      "skill",
      "Run the resource probe. Discover the available resource-probe skill, use read to load its SKILL.md, then follow its steps exactly.",
      { timeoutMs: 240_000 },
    );
    const result = await turn;
    const completedTools = new Set<string>();
    for await (const event of turn.events) {
      if (event.type === "tool_end" && !event.isError) completedTools.add(event.tool);
    }

    const templateResult = await agent.sessions.run("template", "/resource-template alpha beta", {
      timeoutMs: 240_000,
    });
    const sessionDirectory = path.join(dataDirectory, agentName, "sessions", "host", "skill");
    const editedFile = path.join(sessionDirectory, "resource.txt");
    const copiedFile = path.join(sessionDirectory, "copied.txt");
    const expected = `final:${skillSecret}`;
    const checks: [string, boolean][] = [
      ["skill instructions reached the model", result.text.trim() === expected],
      [
        "write and edit produced the expected file",
        existsSync(editedFile) && readFileSync(editedFile, "utf8").trim() === expected,
      ],
      [
        "bash copied the edited file inside the sandbox",
        existsSync(copiedFile) && readFileSync(copiedFile, "utf8").trim() === expected,
      ],
      ...["read", "write", "edit", "bash"].map((name): [string, boolean] => [
        `built-in ${name} completed`,
        completedTools.has(name),
      ]),
      [
        "prompt template expanded its body and positional arguments",
        templateResult.text.trim() === `${promptSecret}:alpha:beta`,
      ],
    ];
    for (const [label, passed] of checks)
      console.log(`[resources] ${passed ? "PASS" : "FAIL"}: ${label}`);
    if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
  } finally {
    await agent.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}
