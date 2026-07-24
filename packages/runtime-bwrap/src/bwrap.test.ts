import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBwrapArgs, buildSessionArgs, buildSpawnEnv, writeSessionConfig } from "./bwrap.js";
import type { SpawnRequest } from "@picco-agent/core";

const cwd = "/workspace/sessions/telegram/42";

/**
 * The [flag, source, dest] triple for a given source, or undefined.
 */
function bindFor(args: string[], source: string): [string, string, string] | undefined {
  const i = args.findIndex((a, n) => a === source && (args[n - 1] ?? "").endsWith("-bind"));
  return i === -1 ? undefined : [args[i - 1]!, args[i]!, args[i + 1]!];
}

describe("buildBwrapArgs mounts", () => {
  it("mounts at the source path by default", () => {
    const args = buildBwrapArgs(cwd, [{ source: "/repo/node_modules", mode: "ro" }]);
    expect(bindFor(args, "/repo/node_modules")).toEqual([
      "--ro-bind",
      "/repo/node_modules",
      "/repo/node_modules",
    ]);
  });

  it("mounts at an explicit absolute target", () => {
    const args = buildBwrapArgs(cwd, [{ source: "/repo/data", target: "/srv/data", mode: "rw" }]);
    expect(bindFor(args, "/repo/data")).toEqual(["--bind", "/repo/data", "/srv/data"]);
  });

  it("resolves a ~/ target against the session cwd (the sandbox HOME)", () => {
    const args = buildBwrapArgs(cwd, [
      { source: "/repo/agents", target: "~/.pi/agents", mode: "ro" },
    ]);
    expect(bindFor(args, "/repo/agents")).toEqual([
      "--ro-bind",
      "/repo/agents",
      `${cwd}/.pi/agents`,
    ]);
  });
});

describe("buildSpawnEnv", () => {
  afterEach(() => {
    delete process.env.TEST_FORWARDED;
  });

  it("HOME is the session cwd; pi config dir and git identity are wired", () => {
    const env = buildSpawnEnv({}, cwd);
    expect(env.HOME).toBe(cwd);
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(cwd, ".pi", "agent"));
    expect(env.GIT_CONFIG_GLOBAL).toBe(`${os.homedir()}/.gitconfig`);
    // No terminal in a session: git must fail fast, never prompt.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("forwards only the named host env vars that are set", () => {
    process.env.TEST_FORWARDED = "yes";
    const env = buildSpawnEnv({ env: ["TEST_FORWARDED", "TEST_UNSET"] }, cwd);
    expect(env.TEST_FORWARDED).toBe("yes");
    expect("TEST_UNSET" in env).toBe(false);
  });

  it("per-spawn vars win over forwarded and default vars", () => {
    process.env.TEST_FORWARDED = "host";
    const env = buildSpawnEnv({ env: ["TEST_FORWARDED"] }, cwd, {
      TEST_FORWARDED: "session",
      HOME: "/elsewhere",
    });
    expect(env.TEST_FORWARDED).toBe("session");
    expect(env.HOME).toBe("/elsewhere");
  });
});

describe("buildSessionArgs", () => {
  let sessionCwd: string;

  afterEach(() => {
    if (sessionCwd) rmSync(sessionCwd, { recursive: true, force: true });
  });

  function spec(over: Partial<SpawnRequest> = {}): SpawnRequest {
    sessionCwd = mkdtempSync(path.join(os.tmpdir(), "bwrap-spec-"));
    return {
      ref: { source: "telegram", key: "42" },
      cwd: sessionCwd,
      env: {},
      pi: {},
      bridge: { url: "http://127.0.0.1:4321/call" },
      ...over,
    };
  }

  it("binds extra mounts read-only", () => {
    const args = buildSessionArgs({ mounts: [{ source: "/ws/node_modules", mode: "ro" }] }, spec());
    expect(bindFor(args, "/ws/node_modules")).toEqual([
      "--ro-bind",
      "/ws/node_modules",
      "/ws/node_modules",
    ]);
  });

  it("rejects mounts at or above Pi's generated configuration", () => {
    const s = spec();
    for (const target of ["~/.pi", "~/.pi/agent"]) {
      expect(() =>
        buildSessionArgs({ mounts: [{ source: "/ws/shared", target, mode: "rw" }] }, s),
      ).toThrow("mount only extension-owned subdirectories");
    }
  });

  it("allows mounts inside Pi's generated configuration directory", () => {
    const args = buildSessionArgs(
      {
        mounts: [
          {
            source: "/ws/memory",
            target: "~/.pi/agent/pi-hermes-memory",
            mode: "rw",
          },
        ],
      },
      spec(),
    );

    expect(bindFor(args, "/ws/memory")).toEqual([
      "--bind",
      "/ws/memory",
      `${sessionCwd}/.pi/agent/pi-hermes-memory`,
    ]);
  });

  it("binds skill and prompt directories read-only", () => {
    const s = spec();
    const skills = path.join(s.cwd, "skills");
    mkdirSync(skills, { recursive: true });
    s.pi = { skills: [skills] };

    const args = buildSessionArgs({}, s);

    expect(bindFor(args, realpathSync(skills))).toEqual([
      "--ro-bind",
      realpathSync(skills),
      realpathSync(skills),
    ]);
  });

  it("binds file-path extensions read-only", () => {
    const s = spec();
    const bundle = path.join(s.cwd, "bridge.js");
    writeFileSync(bundle, "// extension bundle");
    s.pi = { extensions: [bundle] };

    const args = buildSessionArgs({}, s);

    expect(bindFor(args, realpathSync(bundle))).toEqual([
      "--ro-bind",
      realpathSync(bundle),
      realpathSync(bundle),
    ]);
  });

  it("starts pi in RPC mode with the correct flags", () => {
    const s = spec({
      pi: {
        model: "anthropic/claude-sonnet-4-5",
        thinking: "high",
        instructions: "You are a test agent.",
      },
    });
    const args = buildSessionArgs({}, s);

    // Find where pi is invoked
    const piIndex = args.indexOf("pi");
    expect(piIndex).toBeGreaterThan(0);
    expect(args[piIndex + 1]).toBe("--mode");
    expect(args[piIndex + 2]).toBe("rpc");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet-4-5");
    expect(args).toContain("--thinking");
    expect(args).toContain("high");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are a test agent.");
    expect(args).toContain("--approve");
  });

  it("passes skill and prompt paths as CLI flags", () => {
    const s = spec();
    const skills = path.join(s.cwd, "skills");
    const prompts = path.join(s.cwd, "prompts");
    mkdirSync(skills, { recursive: true });
    mkdirSync(prompts, { recursive: true });
    s.pi = { skills: [skills], prompts: [prompts] };

    const args = buildSessionArgs({}, s);

    expect(args).toContain("--skill");
    const skillIdx = args.indexOf("--skill");
    expect(args[skillIdx + 1]).toBe(skills);
    expect(args).toContain("--prompt-template");
    const promptIdx = args.indexOf("--prompt-template");
    expect(args[promptIdx + 1]).toBe(prompts);
  });

  it("drops a nonexistent skill from both the mounts and the CLI flags", () => {
    const s = spec();
    const real = path.join(s.cwd, "skills");
    mkdirSync(real, { recursive: true });
    const missing = path.join(s.cwd, "ghost-skills");
    s.pi = { skills: [real, missing] };

    const args = buildSessionArgs({}, s);
    const joined = args.join(" ");

    // The real skill is mounted and flagged; the missing one appears nowhere.
    expect(bindFor(args, real)).toEqual(["--ro-bind", real, real]);
    expect(joined).toContain(`--skill ${real}`);
    expect(joined).not.toContain(missing);
  });

  it("no spec.env value ever appears in the built argv", () => {
    const s = spec({
      env: { GH_TOKEN: "tok-sekret-9000", ANTHROPIC_API_KEY: "sk-live-secret" },
      pi: { model: "anthropic/claude-sonnet-4-5" },
    });

    const joined = buildSessionArgs({}, s).join(" ");

    expect(joined).not.toContain("tok-sekret-9000");
    expect(joined).not.toContain("sk-live-secret");
  });
});

describe("writeSessionConfig", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function specWith(over: Partial<SpawnRequest> = {}): SpawnRequest {
    return {
      ref: { source: "telegram", key: "42" },
      cwd: "/unused",
      env: {},
      pi: {},
      bridge: { url: "http://127.0.0.1:4321/call", token: "tok-abc" },
      ...over,
    };
  }

  it("writes each config file from the spec, including the bearer token in bridge.json", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "bwrap-write-"));
    writeSessionConfig(
      specWith({
        bridge: { url: "http://127.0.0.1:4321/call", token: "sk-secret" },
        pi: {
          models: { providers: { fake: { apiKey: "$FAKE_KEY" } } },
          packages: ["npm:context-mode@1.2.0"],
          mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } },
        },
      }),
      dir,
    );

    const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
    expect(read("models.json")).toEqual({ providers: { fake: { apiKey: "$FAKE_KEY" } } });
    expect(read("settings.json")).toEqual({ packages: ["npm:context-mode@1.2.0"] });
    expect(read("mcp.json")).toEqual({
      mcpServers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp" } },
    });
    expect(read("bridge.json").token).toBe("sk-secret");
  });
});
