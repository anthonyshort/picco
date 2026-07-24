import { describe, expect, test } from "vitest";
import { token } from "./token.js";

describe("token", () => {
  test("declares private token instructions and an optional MCP surface", () => {
    expect(
      token({
        name: "acme",
        description: "Acme",
        instructions: "Create a personal token.",
        mcp: { url: "https://mcp.acme.test/mcp" },
      }),
    ).toEqual({
      name: "acme",
      description: "Acme",
      auth: { kind: "token", instructions: "Create a personal token." },
      mcp: { url: "https://mcp.acme.test/mcp" },
    });
  });
});
