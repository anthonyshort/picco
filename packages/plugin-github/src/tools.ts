import type { Plugin } from "@picco-agent/core";
import type { GithubToolsOptions } from "./api.js";
import { createCommentTool } from "./comments.js";
import { createInlineCommentTool, createReviewTool } from "./reviews.js";

/**
 * Expose outbound GitHub PR operations without a relay, poller or local message store.
 */
export function githubTools(options: GithubToolsOptions): Plugin {
  return {
    name: "github-tools",
    tools: [
      createCommentTool(options),
      createInlineCommentTool(options),
      createReviewTool(options),
    ],
  };
}
