import { z } from "zod";
import { FeedbackCandidateSchema } from "./feedback-source.js";
import { type GithubSourceOptions } from "./github-contracts.js";

/**
 * Independent settings for addressing reviews on the authenticated account's PRs.
 */
export const GithubFeedbackSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    skill: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .max(200)
      .default("address-pr-feedback"),
    pollIntervalMs: z.number().int().min(1000).max(86_400_000).default(60_000),
    debounceMs: z.number().int().min(1000).max(86_400_000).default(600_000),
    maxWaitMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
    feedbackTimeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    feedbackDirectory: z.string().min(1).optional(),
  })
  .strict();

/**
 * One batch frozen by store admission: PR head, selected review IDs and worker session. Later
 * discoveries cannot add reviews to this run; retries refer back to its artifacts.
 */
export const FeedbackRunSchema = FeedbackCandidateSchema.extend({
  id: z.uuid(),
  author: z.string().min(1),
  sessionKey: z.string().min(1),
  startedAt: z.iso.datetime(),
  resumeRunId: z.uuid().optional(),
});

/**
 * Evidence declared by the selected worker after the skill succeeds.
 */
export const FeedbackCompletionSchema = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    pushedHead: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    commentUrl: z.url().optional(),
  })
  .strict();

/**
 * The host's selected batch and durable paths passed to a prompt builder.
 */
export const FeedbackSelectionSchema = z.object({
  run: FeedbackRunSchema,
  skill: z.string(),
  artifactDirectory: z.string(),
  publisherStateFile: z.string(),
});

/**
 * Persisted worker outcome, independent of notification delivery.
 */
export const GithubFeedbackResultSchema = z.object({
  selection: FeedbackSelectionSchema,
  status: z.enum(["completed", "blocked", "interrupted"]),
  finishedAt: z.iso.datetime(),
  summary: z.string().optional(),
  pushedHead: z.string().optional(),
  commentUrl: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Validated feedback polling settings.
 */
export type GithubFeedbackSettings = z.infer<typeof GithubFeedbackSettingsSchema>;
/**
 * Durable identity of a selected feedback attempt.
 */
export type FeedbackRun = z.infer<typeof FeedbackRunSchema>;
/**
 * Completion evidence retained before worker teardown.
 */
export type FeedbackCompletion = z.infer<typeof FeedbackCompletionSchema>;
/**
 * Input to application prompts and start callbacks.
 */
export type FeedbackSelection = z.infer<typeof FeedbackSelectionSchema>;
/**
 * Input to application outcome callbacks.
 */
export type GithubFeedbackResult = z.infer<typeof GithubFeedbackResultSchema>;
/**
 * Host-owned transport and lifecycle callbacks for automatic feedback work.
 */
export type GithubFeedbackOptions = z.input<typeof GithubFeedbackSettingsSchema> & {
  github?: GithubSourceOptions;
  prompt?: (selection: FeedbackSelection) => string;
  onRunStart?: (selection: FeedbackSelection) => void | Promise<void>;
  onRunComplete?: (result: GithubFeedbackResult) => void | Promise<void>;
};
