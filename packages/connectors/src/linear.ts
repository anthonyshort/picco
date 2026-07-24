import { mcp } from "./mcp.js";

/**
 * Create Linear's hosted MCP connector using OAuth discovery and dynamic client registration.
 */
export function linear() {
  return mcp({
    name: "linear",
    description: "Linear — issues, projects, and comments (acts as your account)",
    url: "https://mcp.linear.app/mcp",
  });
}
