import { describe, expect, test } from "vitest";
import { mcp } from "./mcp.js";

describe("mcp", () => {
  test("declares discovery with optional registered-client and proxy configuration", () => {
    expect(
      mcp({
        name: "acme",
        description: "Acme",
        url: "https://mcp.acme.test/mcp",
        header: "x-api-token",
        clientId: "client",
        clientSecret: "secret",
      }),
    ).toEqual({
      name: "acme",
      description: "Acme",
      auth: {
        kind: "mcp",
        resource: "https://mcp.acme.test/mcp",
        clientId: "client",
        clientSecret: "secret",
      },
      mcp: { url: "https://mcp.acme.test/mcp", header: "x-api-token" },
    });
  });

  test("description defaults to the name tagged (MCP)", () => {
    expect(mcp({ name: "acme", url: "https://mcp.acme.test/mcp" }).description).toBe("acme (MCP)");
  });
});
