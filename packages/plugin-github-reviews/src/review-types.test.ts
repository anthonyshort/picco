import { describe, expect, test } from "vitest";
import { ReviewStartSchema } from "./review-types.js";

describe("review requests", () => {
  test("normalises repository identity and defaults to a local-only review", () => {
    expect(
      ReviewStartSchema.parse({ repository: "Example/Widgets", number: 42, requestId: "first" }),
    ).toEqual({
      repository: "example/widgets",
      number: 42,
      requestId: "first",
      skill: "review",
      delivery: "local-only",
    });
  });

  test.each(["local-only", "publish"])("accepts explicit %s delivery", (delivery) => {
    expect(
      ReviewStartSchema.parse({
        repository: "example/widgets",
        number: 42,
        requestId: "first",
        delivery,
      }).delivery,
    ).toBe(delivery);
  });

  test.each([null, "comment-only", "approve", true])("rejects invalid delivery: %j", (delivery) => {
    expect(
      ReviewStartSchema.safeParse({
        repository: "example/widgets",
        number: 42,
        requestId: "first",
        delivery,
      }).success,
    ).toBe(false);
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
