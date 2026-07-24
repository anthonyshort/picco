import type { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RuntimeProcess } from "@picco-agent/core";

/**
 * Wrap a spawned child in core's RuntimeProcess contract, so worker tests can drive a raw `pi`
 * process through RpcSession without going via a full runtime. Mirrors the runtimes' own private
 * wrapChild.
 */
export function wrapChild(child: ReturnType<typeof spawn>): RuntimeProcess {
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
