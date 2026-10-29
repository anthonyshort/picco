import * as z from "zod";
import { tool } from "@picco-agent/core";
import { requestGithub, rejected, uncertain, type GithubToolsOptions } from "./api.js";
import { PullRequestSchema, BodySchema, CommentIdSchema, ResourceSchema } from "./schemas.js";

/**
 * Conversation comments use issue-comment endpoints, including on pull requests.
 */
const CommentSchema = ResourceSchema.extend({ issue_url: z.url() });

/**
 * Keep the model's conversation-comment arguments separate from host credentials.
 */
const CommentInputSchema = PullRequestSchema.extend({
  body: BodySchema,
  commentId: CommentIdSchema.optional(),
}).strict();

/**
 * Create a PR conversation comment or edit an existing comment belonging to that PR.
 */
export function createCommentTool(options: GithubToolsOptions) {
  return tool({
    name: "github_comment",
    description:
      "Create a GitHub PR conversation comment, or update it by supplying the returned commentId. Keep comment IDs in your workflow. An uncertain result requires inspecting GitHub before retrying.",
    input: CommentInputSchema,
    execute: async (input, ctx) => JSON.stringify(await writeComment(options, input, ctx.signal)),
  });
}

/**
 * Check membership before PATCH and require a matching receipt after either mutation.
 */
async function writeComment(
  options: GithubToolsOptions,
  input: z.infer<typeof CommentInputSchema>,
  signal?: AbortSignal,
) {
  const issuePath = `/repos/${input.repository}/issues/${input.pullRequest}`;
  const commentPath = `/repos/${input.repository}/issues/comments/${input.commentId}`;
  const matches = (comment: z.infer<typeof CommentSchema>) =>
    comment.issue_url.toLowerCase() === `https://api.github.com${issuePath}` &&
    (input.commentId === undefined || String(comment.id) === input.commentId);
  if (input.commentId) {
    const previous = await requestGithub(options, {
      path: commentPath,
      method: "GET",
      schema: CommentSchema,
      signal,
    });
    if (previous.status !== "confirmed") return previous;
    if (!matches(previous.data)) return rejected("Comment does not belong to this pull request");
  }
  const result = await requestGithub(options, {
    path: input.commentId ? commentPath : `${issuePath}/comments`,
    method: input.commentId ? "PATCH" : "POST",
    body: { body: input.body },
    schema: CommentSchema,
    signal,
  });
  if (result.status !== "confirmed") return result;
  return matches(result.data)
    ? { status: "confirmed", commentId: String(result.data.id) }
    : uncertain();
}
