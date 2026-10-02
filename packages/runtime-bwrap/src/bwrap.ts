import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { Runtime, RuntimeExecOptions, RuntimeProcess, SpawnRequest } from "@picco-agent/core";

const execFileAsync = promisify(execFile);

/**
 * Cap on a command's captured output. Exceeding it kills the child and rejects — a runaway command
 * can't exhaust host memory.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

const HOME = os.homedir();
const BWRAP = "bwrap";
const FHS_PATH = "/usr/local/bin:/usr/bin:/bin";
/**
 * PATH inside the sandbox. The jail mounts only `/usr` read-only, so it can see toolchain bins only
 * under `/usr` — every candidate below is gated on `/usr` (a bin dir the sandbox can't reach is
 * useless on PATH). This requires `pi`/`node` to be a system install under `/usr`; a toolchain
 * under `$HOME` (nvm, fnm) is invisible in the jail and deliberately not added.
 *
 * `process.execPath`'s directory is added when Node and `pi` live beside each other. We also locate
 * `pi` on the host PATH because package-manager shims may live in a different directory.
 */
const DEFAULT_PATH = (() => {
  const dirs: string[] = [];
  const execDir = path.dirname(process.execPath);
  if (execDir.startsWith("/usr/")) dirs.push(execDir);
  const piDir = findOnHostPath("pi");
  if (piDir && piDir.startsWith("/usr/")) dirs.push(piDir);
  dirs.push(FHS_PATH);
  return [...new Set(dirs)].join(":");
})();

/**
 * The directory of the first `bin` on the host PATH, or undefined. Used to locate the pi CLI so the
 * sandbox PATH can include it even when the package-manager shim is separate from Node.
 */
function findOnHostPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, bin))) return dir;
  }
  return undefined;
}

/**
 * A mount entry: a bare string is mounted read-write (host path = sandbox path).
 */
export type MountEntry =
  | string
  | {
      source: string;
      /**
       * Sandbox path to mount at (default: same as source). A leading `~/` resolves against the
       * session cwd — the sandbox's HOME — so a repo directory can appear where an extension looks
       * for it (e.g. mount `./agents` at `~/.pi/agents`).
       */
      target?: string;
      mode: "ro" | "rw";
    };

export interface BwrapOptions {
  /**
   * Host env var names forwarded into the sandbox (e.g. ANTHROPIC_API_KEY).
   */
  env?: string[];
  /**
   * Extra mounts (host path = sandbox path unless `target` says otherwise). Strings mount
   * read-write; pass { source, mode: "ro" } for read-only (e.g. a workspace layout's extra
   * node_modules trees).
   */
  mounts?: MountEntry[];
  /**
   * PATH inside the sandbox. Only affects commands the agent runs.
   */
  path?: string;
}

type NormalizedMount = { source: string; target?: string; mode: "ro" | "rw" };

/**
 * The bubblewrap Runtime (see the file header for what it isolates).
 */
export function bwrap(options: BwrapOptions = {}): Runtime {
  return {
    name: "bwrap",

    async check(): Promise<void> {
      try {
        await execFileAsync(BWRAP, ["--version"]);
      } catch (err) {
        throw new Error(
          `bwrap is not available on this host (install bubblewrap ≥ 0.8): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      // Verify node is available (pi is a Node.js CLI).
      await execFileAsync("node", ["--version"]);
      // Verify pi CLI is available on PATH.
      await execFileAsync("pi", ["--version"]);
    },

    async spawn(spec: SpawnRequest): Promise<RuntimeProcess> {
      // Write pi's config files to the workspace before spawning.
      writeSessionConfig(spec, path.join(spec.cwd, ".pi", "agent"));

      const args = buildSessionArgs(options, spec);
      const child = spawn(BWRAP, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSpawnEnv(options, spec.cwd, spec.env),
      });
      return wrapChild(child);
    },

    async exec(opts: RuntimeExecOptions): Promise<string> {
      const args = buildBwrapArgs(opts.cwd, normalizeMounts(options.mounts));
      args.push("sh", "-c", opts.command);

      return execCollect(BWRAP, args, {
        env: buildSpawnEnv(options, opts.cwd),
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}

/**
 * Normalize MountEntry[] to the shape buildBwrapArgs takes.
 */
function normalizeMounts(mounts: MountEntry[] = []): NormalizedMount[] {
  return mounts.map((m) => (typeof m === "string" ? { source: m, mode: "rw" as const } : m));
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
  // authenticates its /call requests. Written 0600 in the session's private dir (mounted into
  // the sandbox), so the token never rides argv.
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
 * Resolve where a mount lands in the sandbox: absent target → the source path; `~` or `~/...` →
 * under the session cwd (the sandbox's HOME).
 */
function resolveMountTarget(cwd: string, mount: NormalizedMount): string {
  const { source, target } = mount;
  if (!target) return source;
  if (target === "~") return cwd;
  if (target.startsWith("~/")) return path.join(cwd, target.slice(2));
  return target;
}

/**
 * Minimal sandbox environment: PATH + HOME, the session's config dir, bwrap's forwarded host vars,
 * then any per-spawn vars (per-session credentials) winning.
 *
 * HOME is the session cwd: it's the only writable per-session directory, so `~` resolves somewhere
 * real and extensions that write ~/.config or ~/.cache get an ephemeral, session-scoped home
 * instead of a dangling host path. PI_CODING_AGENT_DIR points pi (and the bridge extension) at the
 * session's config dir explicitly, so config discovery doesn't hinge on HOME. Git identity survives
 * via GIT_CONFIG_GLOBAL, which points at the host ~/.gitconfig mount (git treats a missing file as
 * empty).
 */
export function buildSpawnEnv(
  options: BwrapOptions,
  cwd: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: options.path ?? DEFAULT_PATH,
    HOME: cwd,
    PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
    GIT_CONFIG_GLOBAL: `${HOME}/.gitconfig`,
    // Headless sessions have no terminal: a git credential prompt would
    // block on the worker's silent stdin until the turn times out. Fail
    // fast instead ("could not read Username").
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of options.env ?? []) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return Object.assign(env, extra);
}

/**
 * Build bubblewrap args for a sandboxed subprocess. The caller appends the command to run (e.g. the
 * worker argv).
 *
 * Secrets are deliberately kept out of these args (argv is world-readable via /proc): the
 * environment goes on the spawn call instead — bwrap forwards its own environment to the child.
 */
export function buildBwrapArgs(cwd: string, mounts: NormalizedMount[] = []): string[] {
  const mountArgs = mounts.flatMap((mount) => [
    mount.mode === "ro" ? "--ro-bind" : "--bind",
    mount.source,
    resolveMountTarget(cwd, mount),
  ]);
  return [
    // Namespace isolation: unshare everything, then re-share the network (--share-net only has an
    // effect alongside --unshare-all). --unshare-all uses the -try variants for the user and cgroup
    // namespaces, so it works whether bwrap runs via unprivileged user namespaces or setuid.
    "--unshare-all",
    "--share-net",

    // Process isolation
    "--die-with-parent",
    "--new-session",

    // System mounts
    "--dev",
    "/dev",
    "--proc",
    "/proc",

    // Runtime (read-only) — /usr covers node, the pi CLI, and shared libraries.
    "--ro-bind",
    "/usr",
    "/usr",

    // Standard FHS symlinks into /usr (the sandbox root is a bare tmpfs, so
    // the host's /bin → usr/bin etc. don't exist unless recreated; without
    // /lib64 the dynamic linker is unreachable and every binary ENOENTs).
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",

    // TLS + DNS. /etc/ssl is a hard bind — without a trust store the session can't verify certs to
    // the model API, so fail loudly at spawn. /etc/pki is Fedora-only and /etc/resolv.conf is absent
    // in some container/systemd-resolved setups, so both are best-effort.
    "--ro-bind",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/pki",
    "/etc/pki",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",

    // Git config (read-only, skipped if absent)
    "--ro-bind-try",
    `${HOME}/.gitconfig`,
    `${HOME}/.gitconfig`,

    // Workspace (read-write). The worker's pi config lives under
    // {cwd}/.pi, written by the runtime before spawn — the user's ~/.pi
    // is never mounted at all.
    "--bind",
    cwd,
    cwd,

    // Custom + per-spawn mounts
    ...mountArgs,

    // Isolated tmpfs
    "--tmpfs",
    "/tmp",

    // Start inside the workspace
    "--chdir",
    cwd,
  ];
}

/**
 * Build the complete bwrap argv for one session: mounts (custom + skills/ prompts from the spec),
 * then `pi --mode rpc` with CLI flags derived from the resolved pi config. Pure and exported so
 * tests can prove what a spawn would run without spawning (no spec.env value appears here).
 */
export function buildSessionArgs(options: BwrapOptions, spec: SpawnRequest): string[] {
  const mounts = normalizeMounts(options.mounts);
  const agentDir = path.join(spec.cwd, ".pi", "agent");
  for (const mount of mounts) {
    const target = resolveMountTarget(spec.cwd, mount);
    const configPath = path.relative(target, agentDir);
    if (configPath === "" || (!configPath.startsWith("..") && !path.isAbsolute(configPath))) {
      throw new Error(
        `Mount target ${target} hides Pi's generated configuration at ${agentDir}; mount only extension-owned subdirectories`,
      );
    }
  }

  // Skill, prompt, and file-path extension paths that actually exist on the host. A nonexistent
  // path is dropped here so it can't take down the spawn — a --ro-bind of a missing source fails,
  // and a --skill/--prompt-template flag for an unmounted path would point at nothing. Both the
  // mounts below and the CLI flags further down use these filtered lists, so the two never disagree.
  //
  // A file-path extension must be self-contained (a single bundled file, or a directory that
  // carries its own deps) — a mounted file brings no node_modules; mount those separately.
  const skills = (spec.pi.skills ?? []).filter((p) => existsSync(p));
  const prompts = (spec.pi.prompts ?? []).filter((p) => existsSync(p));
  const extensions = (spec.pi.extensions ?? []).filter((p) => existsSync(p));

  // Mounted read-only so pi can read them at their host paths inside the sandbox.
  const resourceMounts: NormalizedMount[] = [...skills, ...prompts, ...extensions].map(
    (source) => ({
      source,
      mode: "ro" as const,
    }),
  );

  const args = buildBwrapArgs(spec.cwd, [...mounts, ...resourceMounts]);

  // Build pi --mode rpc CLI args.
  args.push("pi", "--mode", "rpc");

  if (spec.pi.model) args.push("--model", spec.pi.model);
  if (spec.pi.thinking) args.push("--thinking", spec.pi.thinking);
  if (spec.pi.instructions) args.push("--append-system-prompt", spec.pi.instructions);
  if (spec.pi.systemPrompt) args.push("--system-prompt", spec.pi.systemPrompt);
  if (spec.pi.allowedTools?.length) args.push("--tools", spec.pi.allowedTools.join(","));
  if (spec.pi.excludedTools?.length) args.push("--exclude-tools", spec.pi.excludedTools.join(","));

  // Skills and prompts as CLI flags (pi discovers files in the directories). Same filtered lists as
  // the mounts above, so every flagged path is one the sandbox actually has.
  for (const p of skills) args.push("--skill", p);
  for (const p of prompts) args.push("--prompt-template", p);

  // Trust project-local resources (extensions, settings) without prompting.
  args.push("--approve");

  // Resume the session's prior conversation unless the kernel asked for a fresh one (reset / new).
  // --continue reopens the most recent transcript in --session-dir; on the first spawn (none yet)
  // pi starts fresh. Omitting it makes pi begin a new session, leaving prior transcripts on disk.
  if (spec.resume !== false) args.push("--continue");

  // Write the transcript flat in the session dir (which bwrap mounts read-write, so it persists
  // on the host across respawns). pi's default nests it under a mangled encoding of the absolute
  // cwd ({agentDir}/sessions/--<encoded-cwd>--/); that per-cwd namespacing is redundant here.
  args.push("--session-dir", spec.cwd);

  return args;
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
