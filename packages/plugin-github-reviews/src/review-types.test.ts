import { describe, expect, test } from "vitest";
import { ReviewStartSchema } from "./review-types.js";

describe("review requests", () => {
  test("normalises repository identity and supplies the default review skill", () => {
    expect(
      ReviewStartSchema.parse({ repository: "Example/Widgets", number: 42, requestId: "first" }),
    ).toEqual({ repository: "example/widgets", number: 42, requestId: "first", skill: "review" });
  });

  test.each([
    { repository: "https://github.com/example/widgets", number: 42, requestId: "first" },
    { repository: "example/widgets", number: 0, requestId: "first" },
    { repository: "example/widgets", number: 1.5, requestId: "first" },
    { url: "https://github.com/example/widgets/pull/42", requestId: "first" },
  ])("rejects invalid review identity: %j", (input) => {
    expect(ReviewStartSchema.safeParse(input).success).toBe(false);
  });
});
