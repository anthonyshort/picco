import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Plugin } from "@picco-agent/core";
import { openReviewDatabase } from "./persistence/database.js";
import { ReviewRepository } from "./persistence/review-repository.js";
import { Reviews } from "./reviews.js";
import { createReviewTools } from "./tools.js";
import { GithubReviewsSettingsSchema, type GithubReviewsOptions } from "./types.js";
import { observeWorkflows } from "./workflows.js";

/**
 * Own GitHub reviews and their execution; polling discovers review requests.
 */
export function githubReviews(opts: GithubReviewsOptions): Plugin {
  const { github, prompt, onRunStart, onRunComplete, resultSchema, ...input } = opts;
  const settings = GithubReviewsSettingsSchema.parse(input);
  const options = {
    ...settings,
    github,
    prompt,
    onRunStart,
    onRunComplete,
    resultSchema,
  };
  let reviews: Reviews | undefined;
  let database: DatabaseSync | undefined;
  /**
   * Return the started service or reject tool calls outside its lifetime.
   */
  function ensureReviews() {
    if (!reviews) throw new Error("GitHub reviews plugin is not started");
    return reviews;
  }
  return {
    name: "github-reviews",
    tools: createReviewTools(ensureReviews, "tool"),
    mcpTools: createReviewTools(ensureReviews, "mcp"),
    prepareExecution: settings.holdWorkflows ? observeWorkflows : undefined,
    start(ctx) {
      if (reviews) throw new Error("GitHub reviews plugin is already started");
      const directory = path.resolve(settings.reviewsDirectory ?? ctx.filePath());
      database = openReviewDatabase(path.join(directory, "reviews.sqlite"));
      try {
        reviews = new Reviews(new ReviewRepository(database), ctx, settings, options, directory);
        reviews.start();
      } catch (err) {
        reviews = undefined;
        database.close();
        database = undefined;
        throw err;
      }
    },
    async stop() {
      if (!reviews) return;
      try {
        await reviews.stop();
      } finally {
        reviews = undefined;
        database?.close();
        database = undefined;
      }
    },
  };
}

export { GithubReviewsSettingsSchema } from "./types.js";
export type {
  GithubReviewsOptions,
  GithubReviewsSettings,
  GithubReviewResult,
  ReviewSelection,
} from "./types.js";
export type { ReviewJob, ReviewAttempt } from "./review-types.js";
export type { GithubExecute } from "./github.js";
export { githubFeedback } from "./feedback.js";
export { GithubFeedbackSettingsSchema } from "./feedback-types.js";
export type {
  GithubFeedbackOptions,
  GithubFeedbackSettings,
  FeedbackSelection,
  GithubFeedbackResult,
} from "./feedback-types.js";
