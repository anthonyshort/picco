import path from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentPaths } from "./agent-paths.js";

describe("createAgentPaths", () => {
  const paths = createAgentPaths("/data", "assistant");
  const root = path.join("/data", "assistant");

  test("roots every path at <dataDir>/<name>", () => {
    expect(paths.root).toBe(root);
  });

  test("sessionCwd nests under sessions/<source>/<key>", () => {
    expect(paths.sessionCwd({ source: "telegram", key: "123" })).toBe(
      path.join(root, "sessions", "telegram", "123"),
    );
  });

  test("runCwd places host-initiated runs under sessions/host/<id>", () => {
    expect(paths.runCwd("run-1")).toBe(path.join(root, "sessions", "host", "run-1"));
  });

  test("pluginDir nests under plugins/<pluginName>", () => {
    expect(paths.pluginDir("cron")).toBe(path.join(root, "plugins", "cron"));
  });
});
