import { describe, expect, test } from "vitest";
import { assertValidSchedule, validateCronExpression } from "./schedule.js";

describe("validateCronExpression", () => {
  test("accepts a valid 6-field expression", () => {
    expect(validateCronExpression("0 30 9 * * 1")).toEqual({ valid: true });
  });

  test("rejects the wrong number of fields", () => {
    expect(validateCronExpression("30 9 * * 1")).toEqual({
      valid: false,
      error: expect.stringMatching(/6 fields/),
    });
  });

  test("rejects a malformed field", () => {
    expect(validateCronExpression("0 99 9 * * 1")).toEqual({
      valid: false,
      error: expect.any(String),
    });
  });

  test("rejects non-cron forms", () => {
    expect(validateCronExpression("5m").valid).toBe(false);
    expect(validateCronExpression("+10m").valid).toBe(false);
    expect(validateCronExpression("2026-06-30T09:00:00.000Z").valid).toBe(false);
  });
});

describe("assertValidSchedule", () => {
  test("throws with the reason and a usable example", () => {
    expect(() => assertValidSchedule("5m")).toThrow(/Invalid schedule "5m".*6-field cron/s);
    expect(() => assertValidSchedule("0 30 9 * * 1")).not.toThrow();
  });
});
