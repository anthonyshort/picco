import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  test.each(["reviewed_commits", "review_runs", "poller_state"])(
    "populated legacy %s requires migration without changing history",
    (table) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "review-legacy-"));
      const filename = path.join(directory, "reviews.sqlite");
      const legacy = new DatabaseSync(filename);
      legacy.exec(
        `CREATE TABLE ${table}(evidence TEXT); INSERT INTO ${table} VALUES ('preserve');`,
      );
      legacy.close();
      try {
        expect(() => openReviewDatabase(filename)).toThrow("reviewed migration");
        const verify = new DatabaseSync(filename);
        expect(verify.prepare(`SELECT evidence FROM ${table}`).get()?.evidence).toBe("preserve");
        expect(
          verify.prepare("SELECT name FROM sqlite_master WHERE name='review_jobs'").get(),
        ).toBeUndefined();
        verify.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
