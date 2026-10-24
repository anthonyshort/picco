import { describe, expect, test } from "vitest";
import { classifyFailure } from "./failure.js";

describe("classifyFailure", () => {
  test.each([
    [
      { code: "auth" },
      { category: "authentication", code: "auth", reason: "credentials_unavailable" },
    ],
    [
      { code: "oauth" },
      { category: "authentication", code: "oauth", reason: "credentials_unavailable" },
    ],
    [
      { code: 401 },
      { category: "authentication", statusCode: 401, reason: "authentication_rejected" },
    ],
    [
      { code: "token_expired" },
      { category: "authentication", code: "token_expired", reason: "credentials_expired" },
    ],
    [
      { code: "provider", statusCode: 429 },
      { category: "rate_limit", statusCode: 429 },
    ],
    [{ status: 403 }, { category: "permission", statusCode: 403 }],
    ["HTTP 503: raw response", { category: "provider_unavailable", statusCode: 503 }],
    [
      new Error(
        'Authentication failed for "fixture". Credentials may have expired or network is unavailable. Run /login.',
      ),
      { category: "authentication", reason: "credentials_unavailable" },
    ],
    [
      new Error(
        'API key auth failed for provider fixture: Authentication failed for "fixture". Credentials may have expired or network is unavailable.',
      ),
      { category: "authentication", reason: "credentials_unavailable" },
    ],
    [new Error("arbitrary response mentioning 401"), { category: "unknown" }],
    [{ code: "private-token", message: "private response" }, { category: "unknown" }],
  ])("selects evidence from %j", (source, expected) => {
    expect(classifyFailure(source, "model")).toEqual({ ...expected, phase: "model" });
  });

  test("diagnostic codes are selected without spreading attached content", () => {
    expect(
      classifyFailure("private response", "model", [
        { error: { code: 401, stack: "private stack" }, details: { token: "private-token" } },
      ]),
    ).toEqual({
      category: "authentication",
      phase: "model",
      statusCode: 401,
      reason: "authentication_rejected",
    });
  });
});
