import { describe, expect, test } from "vitest";
import { silentLogger, type ToolContext } from "@picco-agent/core";
import { createReviewFinishTools } from "./review-finish-tools.js";
import type { ReviewFinish } from "./review-types.js";

const FINISH_TOOLS = ["github_review_finish", "github_review_complete"] as const;

describe("review finish tools", () => {
  test.each(FINISH_TOOLS)(
    "%s rejects host, wrong source and wrong session callers",
    async (name) => {
      const recorded: ReviewFinish[] = [];
      const selected = createReviewFinishTools("selected", async (input) => {
        recorded.push(input);
        return "Saved";
      }).find((entry) => entry.name === name)!;
      const input = selected.input.parse(
        name === "github_review_finish"
          ? { status: "completed", summary: "Done" }
          : { summary: "Done" },
      );
      const callers: ToolContext["caller"][] = [
        { kind: "host" },
        { kind: "session", ref: { source: "other", key: "selected" } },
        { kind: "session", ref: { source: "github-reviews", key: "other" } },
      ];
      for (const caller of callers)
        await expect(selected.execute(input, { caller, logger: silentLogger() })).rejects.toThrow(
          "selected review session",
        );
      expect(recorded).toEqual([]);
      await selected.execute(input, {
        caller: { kind: "session", ref: { source: "github-reviews", key: "selected" } },
        logger: silentLogger(),
      });
      expect(recorded).toEqual([{ status: "completed", summary: "Done" }]);
    },
  );
});
