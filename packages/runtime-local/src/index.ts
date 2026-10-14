import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { Runtime, RuntimeExecOptions, RuntimeProcess, SpawnRequest } from "@picco-agent/core";

const execFileAsync = promisify(execFile);

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Cap on a command's captured output. Exceeding it kills the child and rejects — a runaway command
 * can't exhaust host memory.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The no-isolation runtime. Sessions and `exec` run as ordinary host processes with the operator's
 * full environment and filesystem — there is no sandbox. Use it only for trusted code in
 * development and testing; reach for `bwrap` when the session runs anything untrusted.
 */
export function local(): Runtime {
  return {
    name: "local",

    /**
     * Sessions exec the `pi` CLI (a Node program) directly on the host, so the preconditions are
     * just that `node` and `pi` are both on PATH.
     */
    async check(): Promise<void> {
      // node must be on PATH (pi is a Node.js CLI)
      await execCollect("node", ["--version"], {
        env: process.env as Record<string, string>,
        timeoutMs: 5000,
      });
      // pi must be on PATH
      await execCollect("pi", ["--version"], {
        env: process.env as Record<string, string>,
        timeoutMs: 5000,
      });
    },

    async spawn(spec: SpawnRequest): Promise<RuntimeProcess> {
      // Write pi's config files to the workspace before spawning.
      writeSessionConfig(spec, path.join(spec.cwd, ".pi", "agent"));

      const argv = buildPiArgs(spec);
      const child = spawn("pi", argv, {
        cwd: spec.cwd,
        // Pipe [stdin, stdout, stderr] so the host owns all three: it writes RPC requests to stdin,
        // reads the JSONL event stream off stdout, and drains stderr for diagnostics.
        stdio: ["pipe", "pipe", "pipe"],
        env: buildLocalEnv(spec.cwd, spec.env),
      });
      return wrapChild(child);
    },

    /**
     * `sh -c` with the host filesystem fully visible, only the working directory scoped to the
     * throwaway workspace.
     */
    async exec(opts: RuntimeExecOptions): Promise<string> {
      return execCollect("sh", ["-c", opts.command], {
        cwd: opts.cwd,
        env: buildLocalEnv(opts.cwd),
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}

/**
 * Write pi's session config files under `dir` (the session's `.pi/agent` directory). Every field
 * passes through to pi verbatim — pi owns models/auth/mcp resolution. Each file is written only
 * when the spec carries data for it.
 */
export function writeSessionConfig(spec: SpawnRequest, dir: string): void {
  mkdirSync(dir, { recursive: true });

  // Custom providers, verbatim. pi resolves `apiKey` (env interpolation / conventional env vars).
  if (spec.pi.models) {
    writeFileSync(path.join(dir, "models.json"), JSON.stringify(spec.pi.models, null, 2));
  }

  // settings.json layers `packages` (source strings) and `extensions` (file paths) over the raw
  // settings escape hatch.
  const packages = spec.pi.packages;
  const extensions = spec.pi.extensions;
  if (spec.pi.settings || packages?.length || extensions?.length) {
    const settings: Record<string, unknown> = { ...spec.pi.settings };
    if (packages?.length) settings.packages = packages;
    if (extensions?.length) settings.extensions = extensions;
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }

  // Native Pi MCP configuration is passed through verbatim.
  if (spec.pi.mcpServers && Object.keys(spec.pi.mcpServers).length > 0) {
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: spec.pi.mcpServers }, null, 2),
    );
  }

  // bridge.json carries the per-session bearer token value; the extension reads it and
  // authenticates its /call requests. Written 0600 in the session's private dir.
  if (spec.bridge.token) {
    writeFileSync(
      path.join(dir, "bridge.json"),
      JSON.stringify(
        { url: spec.bridge.url, token: spec.bridge.token, tools: spec.tools ?? [] },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}

/**
 * Build pi --mode rpc CLI args from the resolved session config. Pure and exported so tests can
 * prove what a spawn would run without spawning (no spec.env value appears here).
 */
export function buildPiArgs(spec: SpawnRequest): string[] {
  const args = ["--mode", "rpc"];

  if (spec.pi.model) args.push("--model", spec.pi.model);
  if (spec.pi.thinking) args.push("--thinking", spec.pi.thinking);
  if (spec.pi.instructions) args.push("--append-system-prompt", spec.pi.instructions);
  if (spec.pi.systemPrompt) args.push("--system-prompt", spec.pi.systemPrompt);
  if (spec.pi.allowedTools?.length) args.push("--tools", spec.pi.allowedTools.join(","));
  if (spec.pi.excludedTools?.length) args.push("--exclude-tools", spec.pi.excludedTools.join(","));

  // Skills and prompts as CLI flags.
  for (const p of spec.pi.skills ?? []) args.push("--skill", p);
  for (const p of spec.pi.prompts ?? []) args.push("--prompt-template", p);

  // Trust project-local resources without prompting.
  args.push("--approve");

  // Resume the session's prior conversation unless the kernel asked for a fresh one (reset / new).
  // --continue reopens the most recent transcript in --session-dir; on the first spawn (none yet)
  // pi starts fresh. Omitting it makes pi begin a new session, leaving prior transcripts on disk.
  if (spec.resume !== false) args.push("--continue");

  // Write the transcript flat in the session dir. pi's default nests it under a mangled
  // encoding of the absolute cwd ({agentDir}/sessions/--<encoded-cwd>--/); that per-cwd
  // namespacing is redundant here since every session already has its own dir.
  args.push("--session-dir", spec.cwd);

  return args;
}

/**
 * Child environment for no-isolation runs: the host env is inherited wholesale (local() offers no
 * isolation, so the session gets the process's real environment — including HOME and the operator's
 * git identity), then any per-spawn vars from `extra` win.
 *
 * PI_CODING_AGENT_DIR points pi (and the bridge extension) at the session's own config directory,
 * so config discovery does not depend on HOME — HOME stays the operator's real home, as expected
 * for an unisolated process. GIT_TERMINAL_PROMPT is off so a git credential prompt can't block the
 * worker's silent stdin.
 */
export function buildLocalEnv(cwd: string, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: process.env.PATH ?? DEFAULT_PATH,
    PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/**
 * Run a command to completion and shape the result the way Runtime.exec promises: trimmed stdout
 * with stderr appended under a [stderr] tag; non-zero exit rejects with stderr as the message, a
 * timeout rejects with a "timed out" error.
 */
async function execCollect(
  file: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: opts.env,
      timeout: opts.timeoutMs,
      killSignal: "SIGTERM",
    });
    let output = stdout.trim();
    if (stderr.trim()) output += `\n[stderr] ${stderr.trim()}`;
    return output;
  } catch (err) {
    const error = err as Error & { killed?: boolean; code?: string | number; stderr?: string };
    // A maxBuffer overflow also kills the child (sets `killed`), so check it first — otherwise an
    // over-large output misreports as a timeout.
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes`, { cause: err });
    if (error.killed)
      throw new Error(`Command timed out after ${opts.timeoutMs}ms`, { cause: err });
    throw new Error(error.stderr?.trim() || error.message, { cause: err });
  }
}

/**
 * Wrap a spawned child process in the RuntimeProcess stream contract.
 */
function wrapChild(child: ReturnType<typeof spawn>): RuntimeProcess {
  let exitedFlag = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      exitedFlag = true;
      resolve({ code, signal });
    });
    child.once("error", (err) => {
      exitedFlag = true;
      reject(err);
    });
  });
  // Death is observed via `exited` by every consumer; avoid an unhandled
  // rejection when nobody has attached yet at failure time.
  exited.catch(() => {});

  return {
    stdin: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
    get alive() {
      return !exitedFlag;
    },
    exited,
    // SIGTERM with SIGKILL escalation after 5s (RPC mode handles signals,
    // not JSONL shutdown).
    async kill() {
      if (exitedFlag) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited.catch(() => {});
      clearTimeout(timer);
    },
  };
}
