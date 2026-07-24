import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "@picco-agent/core";
import { buildLocalEnv, buildPiArgs, local, writeSessionConfig } from "./index.js";

const cwd = "/workspace/sessions/telegram/42";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "local-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local().exec", () => {
  const runtime = local();

  it("runs bare on the host — a file outside the workdir is readable", async () => {
    const outside = tmp();
    writeFileSync(path.join(outside, "host-file.txt"), "host-visible");
    const workdir = tmp();

    const out = await runtime.exec({
      cwd: workdir,
      command: `cat ${outside}/host-file.txt && echo "$PWD"`,
      timeoutMs: 15_000,
    });

    expect(out).toContain("host-visible");
    expect(out).toContain(realpathSync(workdir));
  });

  it("inherits the host HOME — local() runs unisolated", async () => {
    const workdir = tmp();
    const out = await runtime.exec({ cwd: workdir, command: 'echo "$HOME"', timeoutMs: 15_000 });
    expect(out).toBe(process.env.HOME);
  });

  it("rejects with stderr when the command fails", async () => {
    await expect(
      runtime.exec({ cwd: tmp(), command: "echo went-wrong >&2; exit 3", timeoutMs: 15_000 }),
    ).rejects.toThrow("went-wrong");
  });

  it("rejects with an output-limit error (not a timeout) when output exceeds the cap", async () => {
    // `yes` emits 8 bytes/line; ~1.8 MiB overflows the 1 MiB maxBuffer near-instantly, well
    // inside the timeout — so a truthful message distinguishes it from a genuine timeout.
    await expect(
      runtime.exec({ cwd: tmp(), command: "yes aaaaaaa | head -n 200000", timeoutMs: 15_000 }),
    ).rejects.toThrow(/output exceeded/);
  });
});

describe("buildLocalEnv", () => {
  afterEach(() => {
    delete process.env.TEST_LEAK;
  });

  it("keeps the host HOME, points pi at the session config dir, and rides the host PATH", () => {
    const env = buildLocalEnv(cwd);
    // HOME is inherited, not overridden — config discovery uses PI_CODING_AGENT_DIR instead.
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(cwd, ".pi", "agent"));
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // No GIT_CONFIG_GLOBAL override — git finds the operator's real ~/.gitconfig via the real HOME.
    expect("GIT_CONFIG_GLOBAL" in env).toBe(false);
  });

  it("the spec's env passes through verbatim and wins over the base", () => {
    const env = buildLocalEnv(cwd, {
      BRIDGE_TOKEN: "tok-123",
      ANTHROPIC_API_KEY: "sk-forwarded",
      HOME: "/elsewhere",
    });
    expect(env.BRIDGE_TOKEN).toBe("tok-123");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-forwarded");
    expect(env.HOME).toBe("/elsewhere");
  });

  it("inherits the host environment — local() offers no isolation", () => {
    process.env.TEST_LEAK = "host-secret";
    const env = buildLocalEnv(cwd);
    expect(env.TEST_LEAK).toBe("host-secret");
  });
});

describe("writeSessionConfig", () => {
  function makeSpec(overrides?: Partial<SpawnRequest>): SpawnRequest {
    return {
      ref: { source: "test", key: "default" },
      cwd: "/unused",
      env: {},
      bridge: { url: "http://localhost:9999", token: "tok-abc" },
      pi: { model: "anthropic/claude-sonnet-4-5" },
      ...overrides,
    };
  }

  function readJson(dir: string, file: string): unknown {
    return JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
  }

  function exists(dir: string, file: string): boolean {
    try {
      readFileSync(path.join(dir, file));
      return true;
    } catch {
      return false;
    }
  }

  it("writes custom providers verbatim to models.json (no apiKey injection)", () => {
    const dir = tmp();
    const models = { providers: { fake: { baseUrl: "http://x", apiKey: "$FAKE_KEY" } } };
    writeSessionConfig(makeSpec({ pi: { models } }), dir);
    expect(readJson(dir, "models.json")).toEqual(models);
  });

  it("omits models.json when no models are configured", () => {
    const dir = tmp();
    writeSessionConfig(makeSpec({ bridge: { url: "http://x" } }), dir);
    expect(exists(dir, "models.json")).toBe(false);
  });

  it("merges settings, packages, and extensions into one settings.json", () => {
    const dir = tmp();
    writeSessionConfig(
      makeSpec({
        pi: {
          packages: ["npm:context-mode@1.2.0"],
          extensions: ["/abs/bundle.js"],
          settings: { subagent: { concurrency: 2 } },
        },
      }),
      dir,
    );
    expect(readJson(dir, "settings.json")).toEqual({
      subagent: { concurrency: 2 },
      packages: ["npm:context-mode@1.2.0"],
      extensions: ["/abs/bundle.js"],
    });
  });

  it("writes settings.json for extensions alone, and omits it when nothing settings-shaped exists", () => {
    const withExt = tmp();
    writeSessionConfig(makeSpec({ pi: { extensions: ["/abs/bundle.js"] } }), withExt);
    expect(readJson(withExt, "settings.json")).toEqual({ extensions: ["/abs/bundle.js"] });

    const bare = tmp();
    writeSessionConfig(makeSpec({ pi: { packages: [], extensions: [] } }), bare);
    expect(exists(bare, "settings.json")).toBe(false);
  });

  it("passes mcpServers through verbatim, and omits mcp.json when empty", () => {
    const withMcp = tmp();
    const mcpServers = {
      custom: { url: "http://localhost:4000/mcp", headers: { "X-Key": "secret" } },
    };
    writeSessionConfig(makeSpec({ pi: { mcpServers } }), withMcp);
    expect(readJson(withMcp, "mcp.json")).toEqual({ mcpServers });

    const empty = tmp();
    writeSessionConfig(makeSpec({ pi: { mcpServers: {} } }), empty);
    expect(exists(empty, "mcp.json")).toBe(false);
  });

  it("writes the per-session bearer token value into bridge.json", () => {
    const dir = tmp();
    writeSessionConfig(
      makeSpec({ bridge: { url: "http://localhost:9999", token: "sk-super-secret" } }),
      dir,
    );
    expect(readJson(dir, "bridge.json")).toEqual({
      url: "http://localhost:9999",
      token: "sk-super-secret",
      tools: [],
    });
  });

  it("omits bridge.json when no token is configured", () => {
    const dir = tmp();
    writeSessionConfig(makeSpec({ bridge: { url: "http://localhost:9999" } }), dir);
    expect(exists(dir, "bridge.json")).toBe(false);
  });

  it("creates the agent directory recursively", () => {
    const dir = path.join(tmp(), "a", "b", "c", "agent");
    writeSessionConfig(makeSpec({ pi: { packages: ["pi-context-mode"] } }), dir);
    expect(readJson(dir, "settings.json")).toEqual({ packages: ["pi-context-mode"] });
  });
});

describe("buildPiArgs", () => {
  function makeSpec(overrides?: Partial<SpawnRequest>): SpawnRequest {
    return {
      ref: { source: "telegram", key: "42" },
      cwd,
      env: {},
      bridge: { url: "http://localhost:9999" },
      pi: {},
      ...overrides,
    };
  }

  it("starts pi in RPC mode and trusts project-local resources", () => {
    const args = buildPiArgs(makeSpec());
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toContain("--approve");
  });

  it("maps every pi setting to its CLI flag", () => {
    const args = buildPiArgs(
      makeSpec({
        pi: {
          model: "anthropic/claude-sonnet-4-5",
          thinking: "high",
          instructions: "You are a test agent.",
          systemPrompt: "Replace the base prompt.",
          allowedTools: ["read", "write"],
          excludedTools: ["shell"],
        },
      }),
    );
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--model")).toBe("anthropic/claude-sonnet-4-5");
    expect(flag("--thinking")).toBe("high");
    expect(flag("--append-system-prompt")).toBe("You are a test agent.");
    expect(flag("--system-prompt")).toBe("Replace the base prompt.");
    expect(flag("--tools")).toBe("read,write");
    expect(flag("--exclude-tools")).toBe("shell");
  });

  it("passes each skill and prompt directory as its own flag", () => {
    const args = buildPiArgs(
      makeSpec({ pi: { skills: ["/s/one", "/s/two"], prompts: ["/p/one"] } }),
    );
    expect(args.filter((a) => a === "--skill")).toHaveLength(2);
    expect(args).toContain("/s/one");
    expect(args).toContain("/s/two");
    const promptIdx = args.indexOf("--prompt-template");
    expect(args[promptIdx + 1]).toBe("/p/one");
  });

  it("writes the transcript flat in the session cwd via --session-dir", () => {
    const args = buildPiArgs(makeSpec());
    expect(args[args.indexOf("--session-dir") + 1]).toBe(cwd);
  });

  it("resumes the prior conversation by default", () => {
    expect(buildPiArgs(makeSpec())).toContain("--continue");
    expect(buildPiArgs(makeSpec({ resume: true }))).toContain("--continue");
  });

  it("starts a fresh session when the kernel asks for a reset", () => {
    expect(buildPiArgs(makeSpec({ resume: false }))).not.toContain("--continue");
  });

  it("keeps no spec.env value in the argv", () => {
    const joined = buildPiArgs(
      makeSpec({ env: { GH_TOKEN: "tok-sekret-9000", ANTHROPIC_API_KEY: "sk-live-secret" } }),
    ).join(" ");
    expect(joined).not.toContain("tok-sekret-9000");
    expect(joined).not.toContain("sk-live-secret");
  });
});
