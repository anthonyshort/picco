import { describe, expect, test } from "vitest";
import { openReviewDatabase } from "./database.js";

describe("review database", () => {
  test("fresh databases have only accepted jobs and attempts", () => {
    const database = openReviewDatabase(":memory:");
    try {
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual(["review_attempts", "review_jobs"]);
    } finally {
      database.close();
    }
  });
});
