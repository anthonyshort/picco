import { describe, expect, test } from "vitest";
import { parseStoredEnvelope } from "./identity-store.js";

describe("parseStoredEnvelope", () => {
  test("accepts the versioned encrypted envelope contract", () => {
    expect(
      parseStoredEnvelope({
        v: 1,
        blob: "opaque",
        connectedAt: 100,
        expiresAt: 200,
      }),
    ).toEqual({ v: 1, blob: "opaque", connectedAt: 100, expiresAt: 200 });
  });

  test("rejects malformed and unknown-version envelopes", () => {
    expect(parseStoredEnvelope({ v: 2, blob: "opaque", connectedAt: 100 })).toBeNull();
    expect(parseStoredEnvelope({ v: 1, blob: 42, connectedAt: 100 })).toBeNull();
  });
});
