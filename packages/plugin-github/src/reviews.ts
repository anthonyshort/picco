import * as z from "zod";
import { tool } from "@picco-agent/core";
import { requestGithub, uncertain, type GithubToolsOptions } from "./api.js";
import {
  PullRequestSchema,
  BodySchema,
  CommitIdSchema,
  InlineCommentSchema,
  ResourceSchema,
  inlinePayload,
} from "./schemas.js";

/**
 * Diff comments and reviews identify their owning pull request in the receipt.
 */
const ReviewResourceSchema = ResourceSchema.extend({ pull_request_url: z.url() });

/**
 * An explicit event submits the review immediately instead of creating pending state.
 */
const ReviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);

/**
 * Confirm that GitHub returned the submitted event rather than pending or other review state.
 */
const REVIEW_STATES = {
  comment: "COMMENTED",
  approve: "APPROVED",
  request_changes: "CHANGES_REQUESTED",
} as const;

/**
 * Add one diff comment at an inspected commit, resolving the current head only when omitted.
 */
export function createInlineCommentTool(options: GithubToolsOptions) {
  return tool({
    name: "github_inline_comment",
    description:
      "Add an inline GitHub PR diff comment. Supply commitId for the revision you inspected; otherwise the current head is used. An uncertain result requires inspecting GitHub before retrying.",
    input: InlineCommentSchema.safeExtend({
      ...PullRequestSchema.shape,
      commitId: CommitIdSchema.optional(),
    }),
    async execute(input, ctx) {
      const pullPath = `/repos/${input.repository}/pulls/${input.pullRequest}`;
      let commitId = input.commitId;
      if (!commitId) {
        const head = await requestGithub(options, {
          path: pullPath,
          method: "GET",
          signal: ctx.signal,
          schema: z.object({ head: z.object({ sha: CommitIdSchema }) }),
        });
        if (head.status !== "confirmed") return JSON.stringify(head);
        commitId = head.data.head.sha;
      }
      const result = await requestGithub(options, {
        path: `${pullPath}/comments`,
        method: "POST",
        signal: ctx.signal,
        body: { ...inlinePayload(input), commit_id: commitId },
        schema: ReviewResourceSchema,
      });
      if (result.status !== "confirmed") return JSON.stringify(result);
      if (result.data.pull_request_url.toLowerCase() !== `https://api.github.com${pullPath}`)
        return JSON.stringify(uncertain());
      return JSON.stringify({ status: "confirmed", commentId: String(result.data.id) });
    },
  });
}

/**
 * Submit a comment, approval or changes-requested review with optional inline findings.
 */
export function createReviewTool(options: GithubToolsOptions) {
  return tool({
    name: "github_review",
    description:
      "Submit a GitHub PR review: comment, approve, or request_changes (reject). Supply the inspected commitId when reviewing a known revision; otherwise GitHub uses the latest commit. Optional comments submit inline findings in the same review. Inspect uncertain results before retrying.",
    input: PullRequestSchema.extend({
      action: z.enum(["comment", "approve", "request_changes"]),
      body: BodySchema.optional(),
      commitId: CommitIdSchema.optional(),
      comments: z.array(InlineCommentSchema).max(100).optional(),
    })
      .strict()
      .refine(
        (input) => input.action === "approve" || input.body !== undefined,
        "Comment and changes-requested reviews require a body",
      ),
    async execute(input, ctx) {
      const pullPath = `/repos/${input.repository}/pulls/${input.pullRequest}`;
      const result = await requestGithub(options, {
        path: `${pullPath}/reviews`,
        method: "POST",
        signal: ctx.signal,
        body: {
          body: input.body,
          event: ReviewEventSchema.parse(input.action.toUpperCase()),
          commit_id: input.commitId,
          comments: input.comments?.map(inlinePayload),
        },
        schema: ReviewResourceSchema.extend({
          state: z.enum(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]),
        }),
      });
      if (result.status !== "confirmed") return JSON.stringify(result);
      if (
        result.data.pull_request_url.toLowerCase() !== `https://api.github.com${pullPath}` ||
        result.data.state !== REVIEW_STATES[input.action]
      )
        return JSON.stringify(uncertain());
      return JSON.stringify({
        status: "confirmed",
        reviewId: String(result.data.id),
        state: result.data.state,
      });
    },
  });
}
