import { describe, expect, test } from "vitest";
import { linear } from "./linear.js";

describe("linear", () => {
  test("uses Linear's hosted MCP resource for OAuth discovery", () => {
    expect(linear()).toMatchObject({
      name: "linear",
      auth: { kind: "mcp", resource: "https://mcp.linear.app/mcp" },
      mcp: { url: "https://mcp.linear.app/mcp" },
    });
  });
});
