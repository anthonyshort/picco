import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger, silentLogger } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Spy on a console method, suppressing real output, and return the spy.
 */
function spyConsole(method: "log" | "warn" | "error") {
  return vi.spyOn(console, method).mockImplementation(() => {});
}

describe("createLogger", () => {
  test("log() writes a timestamped, prefixed line to console.log", () => {
    const spy = spyConsole("log");
    createLogger("api").log("started");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[api\] started$/,
    );
  });

  test("warning() routes to console.warn", () => {
    const spy = spyConsole("warn");
    createLogger("api").warning("careful");
    expect(spy.mock.calls[0]![0]).toContain("[api] careful");
  });

  test("error() routes to console.error", () => {
    const spy = spyConsole("error");
    createLogger("api").error("broke");
    expect(spy.mock.calls[0]![0]).toContain("[api] broke");
  });

  test("renders object data as space-separated key=value pairs", () => {
    const spy = spyConsole("error");
    createLogger("db").error("query failed", { table: "users", rows: 3 });
    expect(spy.mock.calls[0]![0]).toMatch(/\[db\] query failed — table=users rows=3$/);
  });

  test("renders an Error as its message", () => {
    const spy = spyConsole("error");
    createLogger("db").error("boom", new Error("connection refused"));
    expect(spy.mock.calls[0]![0]).toMatch(/ — connection refused$/);
  });

  test("renders a primitive as its string form", () => {
    const spy = spyConsole("error");
    createLogger("db").error("status", 500);
    expect(spy.mock.calls[0]![0]).toMatch(/ — 500$/);
  });

  test("omits the suffix when there is no data", () => {
    const spy = spyConsole("log");
    createLogger("api").log("ready");
    expect(spy.mock.calls[0]![0]).toMatch(/\[api\] ready$/);
  });

  test("omits the suffix for an empty object", () => {
    const spy = spyConsole("log");
    createLogger("api").log("ready", {});
    expect(spy.mock.calls[0]![0]).toMatch(/\[api\] ready$/);
  });
});

describe("silentLogger", () => {
  test("discards every call without touching the console", () => {
    const log = spyConsole("log");
    const warn = spyConsole("warn");
    const error = spyConsole("error");

    const logger = silentLogger();
    logger.log("a");
    logger.warning("b");
    logger.error("c");

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
