import { describe, expect, test } from "vitest";
import { notion } from "./notion.js";

describe("notion", () => {
  test("uses Notion's hosted MCP resource for OAuth discovery", () => {
    expect(notion()).toMatchObject({
      name: "notion",
      auth: { kind: "mcp", resource: "https://mcp.notion.com/mcp" },
      mcp: { url: "https://mcp.notion.com/mcp" },
    });
  });
});
