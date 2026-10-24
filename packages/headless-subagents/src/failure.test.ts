import { describe, expect, test } from "vitest";
import { classifyFailure } from "./failure.js";
import { DiagnosticEventSchema } from "./types.js";

describe("classifyFailure", () => {
  test.each([
    [{ code: "auth" }, { category: "authentication", reason: "credentials_unavailable" }],
    [{ code: "oauth" }, { category: "authentication", reason: "credentials_unavailable" }],
    [
      { code: "token_expired", status: 401 },
      { category: "authentication", reason: "credentials_expired", statusCode: 401 },
    ],
    [{ code: "token_expired" }, { category: "authentication", reason: "credentials_expired" }],
    [
      { code: "provider", status: 401 },
      { category: "authentication", statusCode: 401, reason: "authentication_rejected" },
    ],
    [{ code: 401 }, { category: "authentication", statusCode: 401 }],
    [{ status: 429 }, { category: "rate_limit", statusCode: 429 }],
    [{ statusCode: 503 }, { category: "provider_unavailable", statusCode: 503 }],
    [{ code: "ECONNRESET" }, { category: "network", code: "ECONNRESET" }],
    [
      new Error(
        'Authentication failed for "fake". Credentials may have expired or network is unavailable. Run /login.',
      ),
      { category: "authentication", reason: "credentials_unavailable" },
    ],
    [
      "API key auth failed for provider fake: private provider error",
      { category: "authentication", reason: "credentials_unavailable" },
    ],
    ["401 authentication failed", { category: "authentication", statusCode: 401 }],
    ["An unrelated error mentions 401", { category: "unknown" }],
    [{ code: "private-token", message: "private error" }, { category: "unknown" }],
  ])("selects supported evidence from %j", (input, expected) => {
    expect(classifyFailure(input, "model")).toMatchObject({ phase: "model", ...expected });
    expect(JSON.stringify(classifyFailure(input, "model"))).not.toContain("private");
  });

  test("specific evidence survives broad diagnostics and credentials never enter metadata", () => {
    expect(
      classifyFailure({ status: 401 }, "model", [
        {
          error: { code: "provider", message: "private error", stack: "private stack" },
          details: { token: "secret" },
        },
      ]),
    ).toEqual({
      category: "authentication",
      phase: "model",
      statusCode: 401,
      reason: "authentication_rejected",
    });
    const diagnostic = DiagnosticEventSchema.parse({
      version: 1,
      at: new Date().toISOString(),
      rootSessionId: "root",
      executionId: "execution",
      agentId: "child",
      parentAgentId: null,
      event: "model.failed",
      data: {
        category: "authentication",
        phase: "model",
        error: "private message",
        stack: "private stack",
        token: "secret",
        body: "private body",
      },
    });
    expect(diagnostic.data).toEqual({ category: "authentication", phase: "model" });
  });
});
