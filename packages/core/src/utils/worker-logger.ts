import * as z from "zod";
import type { Logger } from "../types.js";

const WorkerLogSchema = z.object({
  type: z.literal("picco_log"),
  level: z.enum(["log", "warning", "error"]),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Send structured logs to the host without writing to Pi's RPC stdout.
 */
export function createWorkerLogger(): Logger {
  function write(level: keyof Logger, message: string, data?: unknown): void {
    const fields =
      data === undefined
        ? undefined
        : data !== null &&
            typeof data === "object" &&
            !(data instanceof Error) &&
            !Array.isArray(data)
          ? data
          : { detail: data instanceof Error ? data.message : data };
    console.error(JSON.stringify({ type: "picco_log", level, message, data: fields }));
  }
  return {
    log: (message, data) => write("log", message, data),
    warning: (message, data) => write("warning", message, data),
    error: (message, data) => write("error", message, data),
  };
}

/**
 * Recognise Picco log entries; other stderr output remains ordinary worker diagnostics.
 */
export function readWorkerLog(line: string): z.infer<typeof WorkerLogSchema> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const result = WorkerLogSchema.safeParse(value);
  return result.success ? result.data : null;
}
