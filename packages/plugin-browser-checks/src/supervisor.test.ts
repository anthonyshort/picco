import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { silentLogger, tool, type ToolContext, type SessionOptions } from "@picco-agent/core";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createSupervisor } from "./supervisor.js";
import { BrowserJobSchema, type BrowserChecksOptions, type BrowserProfile } from "./types.js";

const directories: string[] = [];
const profile: BrowserProfile = {
  origins: ["https://preview.example.test"],
  instructions: "Use the disposable filter fixture.",
};
const options: BrowserChecksOptions = {
  atlas: { url: "https://atlas.example.test", token: "host-only-secret", workflow: "browser" },
  profiles: { preview: profile },
};
const plan = {
  url: "https://preview.example.test/settings",
  steps: ["Choose paid status", "Read the filtered rows and total"],
  expected: "Only paid rows remain",
  setup: "Use the disposable fixture",
};
const answer = {
  answer: "supported",
  summary: "Changing the status updated the rows and total.",
  observations: ["Only paid rows were visible after changing status"],
  limits: ["One viewport was checked"],
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("browser supervisor", () => {
  test("prepares and inspects the latest evidence through two turns on one restricted session", async () => {
    const job = createJob();
    const ctx = createContext(async ({ key, prompt }) => {
      if (prompt.includes("Prepare one bounded browser check")) {
        await invoke(ctx, key, "browser_check_plan", plan);
      } else {
        const result = await invoke(ctx, key, "browser_check_evidence", {});
        expect(result).toMatchObject({
          content: [
            { type: "text", text: expect.stringContaining("Only paid rows remained") },
            {
              type: "image",
              mimeType: "image/png",
              data: Buffer.from("actual screenshot").toString("base64"),
            },
          ],
        });
        await invoke(ctx, key, "browser_check_answer", answer);
      }
      return "Recorded";
    });
    const approvedRead = tool({
      name: "fixture_read",
      description: "Read the disposable fixture location.",
      input: z.strictObject({}),
      execute: () => "Fixture is available",
    });
    const environment = { ...profile, tools: [approvedRead] };
    const supervisor = createSupervisor(ctx, options);
    expect(await supervisor.prepare(job, environment, AbortSignal.timeout(1000))).toEqual(plan);
    const screenshot = path.join(createDirectory(), "result.png");
    writeFileSync(screenshot, "actual screenshot");
    const observed = BrowserJobSchema.parse({
      ...job,
      evidence: {
        url: plan.url,
        revision: null,
        revisionEvidence: "Disposable fixture build",
        observations: ["Only paid rows remained"],
        limits: [],
        artifacts: [],
      },
      artifacts: [
        {
          kind: "screenshot",
          source: "https://atlas.example.test/shot.png",
          file: screenshot,
          bytes: 17,
          mimeType: "image/png",
        },
      ],
    });
    expect(await supervisor.assess(observed, environment, AbortSignal.timeout(1000))).toEqual(
      answer,
    );
    expect(ctx.sessionTools).toHaveLength(1);
    expect(ctx.turns.map((turn) => turn.key)).toEqual([job.id, job.id]);
    const session = ctx.sessionOptions[0];
    expect(session?.allowedHostTools).toEqual([
      "fixture_read",
      "browser_check_plan",
      "browser_check_answer",
      "browser_check_evidence",
    ]);
    expect(session?.pi?.allowedTools).toEqual(session?.allowedHostTools);
    expect(session?.pi?.mcpServers).toEqual({});
    expect(session?.ephemeral).not.toBe(true);
    expect(ctx.runTimeouts).toHaveLength(2);
    expect(
      ctx.runTimeouts.every((timeout) => timeout !== undefined && timeout > 0 && timeout <= 10000),
    ).toBe(true);
    expect(ctx.turns.map((turn) => turn.prompt).join("\n")).not.toContain("host-only-secret");
    await supervisor.close(job.id);
    expect(ctx.sessions.list()).toEqual([]);
  });

  test("rejects a prepared target outside the configured origin", async () => {
    const job = createJob();
    const ctx = createContext(async ({ key }) => {
      await invoke(ctx, key, "browser_check_plan", { ...plan, url: "https://other.example.test/" });
      return "Recorded";
    });
    const supervisor = createSupervisor(ctx, options);
    await expect(supervisor.prepare(job, profile, AbortSignal.timeout(1000))).rejects.toThrow(
      "outside",
    );
    await supervisor.close(job.id);
  });

  test("rejects credential-bearing target URLs", async () => {
    const job = createJob();
    const ctx = createContext(async ({ key }) => {
      await invoke(ctx, key, "browser_check_plan", {
        ...plan,
        url: "https://user:secret@preview.example.test/",
      });
      return "Recorded";
    });
    const supervisor = createSupervisor(ctx, options);
    await expect(supervisor.prepare(job, profile, AbortSignal.timeout(1000))).rejects.toThrow(
      "outside",
    );
    await supervisor.close(job.id);
  });

  test("does not accept final prose as a saved plan or answer", async () => {
    const job = createJob();
    const ctx = createContext(() => "Everything worked");
    const supervisor = createSupervisor(ctx, options);
    await expect(supervisor.prepare(job, profile, AbortSignal.timeout(1000))).rejects.toThrow(
      "did not record",
    );
    await expect(supervisor.assess(job, profile, AbortSignal.timeout(1000))).rejects.toThrow(
      "did not record",
    );
    await supervisor.close(job.id);
  });

  test("requires actual image inspection before recording an answer", async () => {
    const job = createJob();
    const ctx = createContext(async ({ key }) => {
      await invoke(ctx, key, "browser_check_answer", answer);
      return "Recorded";
    });
    const supervisor = createSupervisor(ctx, options);
    await expect(supervisor.assess(job, profile, AbortSignal.timeout(1000))).rejects.toThrow(
      /inspect|evidence|image/i,
    );
    await supervisor.close(job.id);
  });

  test("rejects evidence declarations from another job or host caller", async () => {
    const job = createJob();
    const ctx = createContext(async ({ key }) => {
      const owned = ensureTool(ctx, key, "browser_check_plan");
      expect(() =>
        owned.execute(plan, {
          logger: silentLogger(),
          caller: { kind: "session", ref: { source: "browser-checks", key: randomUUID() } },
        }),
      ).toThrow("Only this job");
      expect(() =>
        owned.execute(plan, {
          logger: silentLogger(),
          caller: { kind: "host" },
        }),
      ).toThrow("Only this job");
      await invoke(ctx, key, "browser_check_plan", plan);
      return "Recorded";
    });
    const supervisor = createSupervisor(ctx, options);
    await expect(supervisor.prepare(job, profile, AbortSignal.timeout(1000))).resolves.toEqual(
      plan,
    );
    await supervisor.close(job.id);
  });

  test("does not start a turn after cancellation", async () => {
    const job = createJob();
    const ctx = createContext(() => "Should not run");
    const supervisor = createSupervisor(ctx, options);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before preparation"));
    await expect(supervisor.prepare(job, profile, controller.signal)).rejects.toThrow(
      "Cancelled before preparation",
    );
    expect(ctx.turns).toHaveLength(0);
    await supervisor.close(job.id);
  });
});

/**
 * Execute the real session tool using the identity supplied by Picco's bridge.
 */
function invoke(
  ctx: ReturnType<typeof createFakePluginContext>,
  key: string | null,
  name: string,
  input: unknown,
) {
  const owned = ensureTool(ctx, key, name);
  const context: ToolContext = {
    logger: silentLogger(),
    caller: { kind: "session", ref: { source: "browser-checks", key: key ?? "missing" } },
  };
  return owned.execute(owned.input.parse(input), context);
}

/**
 * Look up the tools bound to an existing fake session.
 */
function ensureTool(
  ctx: ReturnType<typeof createFakePluginContext>,
  key: string | null,
  name: string,
) {
  const owned = ctx.sessionTools
    .find((entry) => entry.key === key)
    ?.tools.find((entry) => entry.name === name);
  if (!owned) throw new Error(`Session tool not found: ${name}`);
  return owned;
}

/**
 * Keep fake session files inside directories owned by this test.
 */
function createContext(reply: NonNullable<Parameters<typeof createFakePluginContext>[0]>["reply"]) {
  const ctx = createFakePluginContext({ source: "browser-checks", reply });
  const directory = createDirectory();
  ctx.filePath = (...segments) => path.join(directory, ...segments);
  const sessionOptions: SessionOptions[] = [];
  const runTimeouts: (number | undefined)[] = [];
  const run = ctx.sessions.run.bind(ctx.sessions);
  ctx.sessions.run = (key, prompt, opts) => {
    if (opts?.session) sessionOptions.push(opts.session);
    runTimeouts.push(opts?.timeoutMs);
    return run(key, prompt, opts);
  };
  return Object.assign(ctx, { sessionOptions, runTimeouts });
}

/**
 * Create a validated job without opening a second SQLite store.
 */
function createJob() {
  return BrowserJobSchema.parse({
    id: randomUUID(),
    owner: "host",
    request: {
      requestKey: randomUUID(),
      profile: "preview",
      question: "Does status filter rows?",
      expected: "Only paid rows remain",
      url: plan.url,
    },
    state: "preparing",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadline: Date.now() + 10000,
    dispatchKey: randomUUID(),
    configuration: null,
    plan: null,
    remote: null,
    remoteStopped: null,
    evidence: null,
    artifacts: [],
    result: null,
    error: null,
  });
}

/**
 * Remove only directories created by this test file.
 */
function createDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-supervisor-"));
  directories.push(directory);
  return directory;
}
