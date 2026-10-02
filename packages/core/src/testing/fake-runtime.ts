import type { JsonObject } from "../session/jsonl.js";
import type { Runtime, RuntimeExecOptions, RuntimeProcess, SpawnRequest } from "../types.js";

/**
 * Scripted behaviour for a FakeRuntimeProcess.
 */
export interface FakeRuntimeProcessOptions {
  /**
   * Reply text for a prompt. Default: `echo: ${prompt}`.
   */
  reply?: (prompt: string) => string | Promise<string>;
  /**
   * Raw RPC events emitted between the prompt ack and agent_settled (e.g. tool_execution_start/end,
   * message_update).
   */
  eventsFor?: (prompt: string) => JsonObject[];
  /**
   * Token total returned by get_session_stats. Default 1234.
   */
  tokens?: number | null;
  /**
   * Handle a prompt as an extension command without starting an agent run.
   */
  handlePrompt?: boolean;
  /**
   * Simulate a crash: the process dies when it receives a prompt.
   */
  dieOnPrompt?: boolean;
  /**
   * Never send agent_settled — for timeout/abort tests.
   */
  neverFinish?: boolean;
  /**
   * The process exits immediately after spawn (before the ready check).
   */
  exitOnSpawn?: { code: number; stderr?: string };
}

/**
 * A scripted RuntimeProcess speaking just enough of pi's RPC JSONL protocol.
 */
export class FakeRuntimeProcess implements RuntimeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  /**
   * Every prompt this process received, in arrival order.
   */
  readonly prompts: string[] = [];
  /**
   * Requests received by this process, including extension UI responses.
   */
  readonly requests: JsonObject[] = [];
  killed = false;

  private exitedFlag = false;
  private resolveExited!: (v: { code: number | null; signal: string | null }) => void;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly behavior: FakeRuntimeProcessOptions;
  private lastReply = "";
  private activePrompt = false;

  constructor(behavior: FakeRuntimeProcessOptions = {}) {
    this.behavior = behavior;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrController = controller;
      },
    });

    let buffer = "";
    const decoder = new TextDecoder();
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.trim()) void this.handleRequest(JSON.parse(line) as JsonObject);
        }
      },
    });

    if (behavior.exitOnSpawn) {
      if (behavior.exitOnSpawn.stderr) this.pushStderr(behavior.exitOnSpawn.stderr);
      this.die(behavior.exitOnSpawn.code);
    }
  }

  get alive(): boolean {
    return !this.exitedFlag;
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.die(null, "SIGTERM");
  }

  /**
   * Emit a raw RPC message on stdout, as pi would.
   */
  push(msg: JsonObject): void {
    if (this.exitedFlag) return;
    this.stdoutController.enqueue(this.encoder.encode(JSON.stringify(msg) + "\n"));
  }

  /**
   * Emit a line on stderr, as pi would.
   */
  pushStderr(line: string): void {
    if (this.exitedFlag) return;
    this.stderrController.enqueue(this.encoder.encode(line + "\n"));
  }

  /**
   * Simulate process exit: close both streams and settle `exited`.
   */
  die(code: number | null, signal: string | null = null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    try {
      this.stdoutController.close();
    } catch {
      /* already closed */
    }
    try {
      this.stderrController.close();
    } catch {
      /* already closed */
    }
    this.resolveExited({ code, signal });
  }

  /**
   * Answer one RPC request according to the scripted behaviour.
   */
  private async handleRequest(msg: JsonObject): Promise<void> {
    this.requests.push(msg);
    const id = msg.id;

    switch (msg.type) {
      case "prompt": {
        if (this.behavior.dieOnPrompt) {
          this.die(1, null);
          return;
        }
        const message = String(msg.message ?? "");
        this.prompts.push(message);
        this.activePrompt = true;
        this.push({
          type: "response",
          command: "prompt",
          id,
          success: true,
          data: { disposition: this.behavior.handlePrompt ? "handled" : "started" },
        });
        if (this.behavior.handlePrompt) {
          this.activePrompt = false;
          return;
        }
        if (this.behavior.neverFinish) return;

        for (const event of this.behavior.eventsFor?.(message) ?? []) {
          this.push(event);
        }
        this.lastReply = await (this.behavior.reply?.(message) ?? `echo: ${message}`);
        this.activePrompt = false;
        this.push({ type: "agent_end" });
        this.push({ type: "agent_settled" });
        return;
      }
      case "get_last_assistant_text":
        this.push({
          type: "response",
          command: "get_last_assistant_text",
          id,
          success: true,
          data: { text: this.lastReply },
        });
        return;
      case "get_session_stats":
        this.push({
          type: "response",
          command: "get_session_stats",
          id,
          success: true,
          data: {
            tokens: { total: this.behavior.tokens === undefined ? 1234 : this.behavior.tokens },
          },
        });
        return;
      case "abort":
        this.push({ type: "response", command: "abort", id, success: true });
        // pi ends the aborted run — emit agent_settled if a prompt is hanging.
        if (this.activePrompt) {
          this.activePrompt = false;
          this.push({ type: "agent_end" });
          this.push({ type: "agent_settled" });
        }
        return;
      case "extension_ui_response":
        return;
      default:
        this.push({
          type: "response",
          command: String(msg.type),
          id,
          success: false,
          error: `unknown: ${msg.type}`,
        });
    }
  }
}

/**
 * One spawn recorded by FakeRuntime.
 */
export interface FakeSpawn {
  /**
   * The SpawnRequest verbatim — read spec.pi as data (no argv to parse).
   */
  spec: SpawnRequest;
  process: FakeRuntimeProcess;
}

/**
 * A Runtime whose processes are scripted FakeRuntimeProcesses. Records every spawn's SpawnRequest
 * verbatim — it never builds argv or touches the filesystem; the fake speaks the RPC protocol over
 * its streams. `behavior` may be a constant or vary per spawn (by call index).
 */
export class FakeRuntime implements Runtime {
  readonly name = "fake";
  readonly spawns: FakeSpawn[] = [];
  /**
   * Every exec (ctx.runtime.exec) call, in order. Element shape is RuntimeExecOptions here —
   * intentionally not { command, timeoutMs }, unlike FakePluginContext.execs.
   */
  readonly execs: RuntimeExecOptions[] = [];
  checked = false;

  constructor(
    private readonly behavior:
      | FakeRuntimeProcessOptions
      | ((spawnIndex: number) => FakeRuntimeProcessOptions) = {},
  ) {}

  async check(): Promise<void> {
    this.checked = true;
  }

  async spawn(spec: SpawnRequest): Promise<RuntimeProcess> {
    const behavior =
      typeof this.behavior === "function" ? this.behavior(this.spawns.length) : this.behavior;
    const process = new FakeRuntimeProcess(behavior);
    this.spawns.push({ spec, process });
    return process;
  }

  async exec(opts: RuntimeExecOptions): Promise<string> {
    this.execs.push(opts);
    return `ran: ${opts.command}`;
  }
}
