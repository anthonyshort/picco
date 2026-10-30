import { z } from "zod";
import { CandidateSchema, type GithubSourceOptions } from "./github.js";
import { StoreRunSchema } from "./store.js";

/**
 * Validated polling and admission settings; callbacks stay in the host process.
 */
export const GithubReviewsSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Hold accepted saved workflows until the review parent handles their completion.
     */
    holdWorkflows: z.boolean().default(false),
    repositories: z
      .array(
        z
          .object({
            name: CandidateSchema.shape.repository,
            skill: z
              .string()
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
              .max(200),
          })
          .strict(),
      )
      .max(100)
      .refine(
        (routes) => new Set(routes.map((route) => route.name)).size === routes.length,
        "Repository routes must be unique",
      )
      .default([]),
    pollIntervalMs: z.number().int().min(1000).max(86_400_000).default(60_000),
    maxPrAgeDays: z.number().int().min(1).max(3650).default(28),
    maxConcurrentReviews: z.number().int().min(1).max(100).default(3),
    reviewTimeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    reviewsDirectory: z.string().min(1).optional(),
  })
  .strict()
  .refine((settings) => !settings.enabled || settings.repositories.length > 0, {
    path: ["repositories"],
    message: "Configure at least one repository before enabling GitHub reviews",
  });

/**
 * Immutable admission plus the writable session directory assigned to this review.
 */
export const ReviewSelectionSchema = z.object({
  run: StoreRunSchema,
  skill: z.string(),
  artifactDirectory: z.string(),
  publisherStateFile: z.string(),
});

/**
 * A completed worker outcome, separate from the success of any remote publication.
 */
export const GithubReviewResultSchema = z.object({
  selection: ReviewSelectionSchema,
  status: z.enum(["completed", "blocked", "interrupted"]),
  finishedAt: z.iso.datetime(),
  summary: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Validated settings with defaults applied.
 */
export type GithubReviewsSettings = z.infer<typeof GithubReviewsSettingsSchema>;

/**
 * Selection passed to an application's prompt builder.
 */
export type ReviewSelection = z.infer<typeof ReviewSelectionSchema>;

/**
 * Durable review outcome passed to the host completion callback.
 */
export type GithubReviewResult = z.infer<typeof GithubReviewResultSchema>;

/**
 * Public plugin options; authentication uses the host's GitHub CLI by default.
 */
export type GithubReviewsOptions = z.input<typeof GithubReviewsSettingsSchema> & {
  prompt?: (selection: ReviewSelection) => string;
  /**
   * Report an admitted review before worker startup. Waits up to 30 seconds; failure is logged
   * without stopping the review or retrying the callback.
   */
  onRunStart?: (selection: ReviewSelection) => void | Promise<void>;
  onRunComplete?: (result: GithubReviewResult) => void | Promise<void>;
  github?: GithubSourceOptions;
};
