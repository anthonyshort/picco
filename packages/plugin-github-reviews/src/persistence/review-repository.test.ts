import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { openReviewDatabase } from "./database.js";
import { ReviewRepository } from "./review-repository.js";
import type { ReviewJob } from "../review-types.js";

describe("review repository", () => {
  test("job writes roll back and unique request keys preserve submission identity", () => {
    const database = openReviewDatabase(":memory:");
    const repository = new ReviewRepository(database);
    const job: ReviewJob = {
      id: randomUUID(),
      requestKey: "client:first",
      source: "mcp",
      repository: "example/widgets",
      number: 42,
      url: "https://github.com/example/widgets/pull/42",
      reviewer: "reviewer",
      requestEventId: null,
      requestedAt: null,
      skill: "review",
      delivery: "local-only",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    try {
      expect(() =>
        repository.transaction(() => {
          repository.saveJob(job);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(repository.list(20)).toEqual([]);
      repository.saveJob(job);
      expect(() => repository.saveJob({ ...job, id: randomUUID() })).toThrow();
      expect(repository.requested("client:first")).toEqual(job);
    } finally {
      database.close();
    }
  });
});
