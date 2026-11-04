import { tool, type Tool, type ToolContext } from "@picco-agent/core";
import { z } from "zod";
import { ReviewFinishSchema, type ReviewFinish } from "./review-types.js";

/**
 * Successful completion shares the canonical summary and report input fields.
 */
const ReviewCompleteSchema = z
  .object({
    summary: ReviewFinishSchema.shape.summary.unwrap(),
    result: ReviewFinishSchema.shape.result,
  })
  .strict();

/**
 * Bind both finish protocols to the selected review session and one recording operation.
 */
export function createReviewFinishTools(
  sessionKey: string,
  submitOutcome: (input: ReviewFinish) => Promise<string>,
): Tool[] {
  const description =
    "Record the final outcome of this selected review after its workflow and required publication finish. Include the full report as JSON in result. Do not declare success for incomplete work.";
  return [
    tool({
      name: "github_review_finish",
      description,
      input: ReviewFinishSchema,
      async execute(input, ctx) {
        ensureSelectedSession(ctx, sessionKey);
        return submitOutcome(input);
      },
    }),
    tool({
      name: "github_review_complete",
      description,
      input: ReviewCompleteSchema,
      async execute(input, ctx) {
        ensureSelectedSession(ctx, sessionKey);
        return submitOutcome({ status: "completed", summary: input.summary, result: input.result });
      },
    }),
  ];
}

/**
 * Host callers and other session identities cannot record this attempt's outcome.
 */
function ensureSelectedSession(ctx: ToolContext, sessionKey: string): void {
  if (
    ctx.caller.kind !== "session" ||
    ctx.caller.ref.source !== "github-reviews" ||
    ctx.caller.ref.key !== sessionKey
  )
    throw new Error("Only this selected review session may record its outcome");
}
