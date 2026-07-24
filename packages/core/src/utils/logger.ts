import type { Logger } from "../types.js";
import { errorMessage } from "./format.js";

/**
 * Console logger whose lines carry a timestamp and the given prefix tag.
 */
export function createLogger(prefix: string): Logger {
  const buildLine = (message: string, data: unknown) =>
    `[${timestamp()}] [${prefix}] ${message}${detail(data)}`;
  return {
    log(message, data) {
      console.log(buildLine(message, data));
    },
    warning(message, data) {
      console.warn(buildLine(message, data));
    },
    error(message, data) {
      console.error(buildLine(message, data));
    },
  };
}

/**
 * A logger that discards everything — handy default for tests.
 */
export function silentLogger(): Logger {
  return { log() {}, warning() {}, error() {} };
}

/**
 * "YYYY-MM-DD HH:MM:SS" timestamp for log lines.
 */
function timestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

/**
 * Render attached data as a " — …" suffix: `key=value` pairs for a plain object, otherwise the
 * value's error/string form. Empty when absent.
 */
function detail(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "object" && !(data instanceof Error)) {
    const parts = Object.entries(data).map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? ` — ${parts.join(" ")}` : "";
  }
  return ` — ${errorMessage(data)}`;
}
