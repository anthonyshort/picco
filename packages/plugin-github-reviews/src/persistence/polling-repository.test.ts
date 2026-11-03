import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { openReviewDatabase } from "./database.js";
import { PollingRepository } from "./polling-repository.js";

/**
 * Verify the extracted polling repository against real SQLite.
 */
describe("PollingRepository", () => {
  test("rolls back failed writes while retaining the existing polling schema", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "picco-polling-repository-"));
    const database = openReviewDatabase(path.join(directory, "reviews.sqlite"));
    const repository = new PollingRepository(database);
    try {
      expect(() =>
        repository.transaction(() => {
          repository.writeState("paused", true);
          throw new Error("State write failed");
        }),
      ).toThrow("State write failed");
      expect(repository.readState("paused")).toBeNull();
      repository.transaction(() => repository.writeState("paused", true));
      expect(repository.readState("paused")).toBe(true);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "poller_state",
        "review_claims",
        "review_queue",
        "review_runs",
        "reviewed_commits",
        "schema_migrations",
      ]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
