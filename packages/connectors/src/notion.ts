import { mcp } from "./mcp.js";

/**
 * Create Notion's hosted MCP connector using OAuth discovery and dynamic client registration.
 */
export function notion() {
  return mcp({
    name: "notion",
    description: "Notion — pages, databases, and comments (acts as your account)",
    url: "https://mcp.notion.com/mcp",
  });
}
