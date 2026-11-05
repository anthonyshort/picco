import { z } from "zod";
import { CandidateSchema, RateLimitSchema } from "./github.js";

/**
 * Saved job and attempt lifecycle states.
 */
export const REVIEW_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

/**
 * Accepted work, independent of any particular worker session.
 */
export const ReviewJobSchema = z.object({
  id: z.uuid(),
  requestKey: z.string().min(1).max(512).nullable(),
  source: z.enum(["poll", "tool", "mcp"]),
  repository: CandidateSchema.shape.repository,
  number: CandidateSchema.shape.number,
  url: z.url(),
  reviewer: z.string(),
  requestEventId: z.string().nullable(),
  requestedAt: z.iso.datetime().nullable(),
  skill: z.string(),
  delivery: z.enum(["publish", "local-only"]),
  status: z.enum(REVIEW_STATUSES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: z.string().nullable(),
});

/**
 * One pinned execution, with its report saved directly beside its outcome.
 */
export const ReviewAttemptSchema = CandidateSchema.extend({
  id: z.uuid(),
  itemId: z.uuid(),
  reviewer: z.string(),
  requestEventId: z.string().optional(),
  requestedAt: z.iso.datetime().optional(),
  base: CandidateSchema.shape.head,
  attempt: z.number().int().positive(),
  sessionKey: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(REVIEW_STATUSES).exclude(["queued"]),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  cleanupError: z.string().nullable(),
  output: z.string().nullable(),
  report: z.unknown().nullable(),
});

/**
 * Caller-owned submission key makes retried start requests idempotent.
 */
export const ReviewStartSchema = z
  .object({
    repository: CandidateSchema.shape.repository,
    number: CandidateSchema.shape.number,
    requestId: z.string().trim().min(1).max(400),
    skill: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .max(200)
      .default("review"),
    delivery: ReviewJobSchema.shape.delivery.default("local-only"),
  })
  .strict();

/**
 * Final outcome submitted once by the selected worker.
 */
export const ReviewFinishSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    summary: z.string().trim().min(1).max(4000).optional(),
    result: z
      .string()
      .max(4 * 1024 * 1024)
      .optional(),
    error: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "completed" && (!value.summary || value.error))
      ctx.addIssue({ code: "custom", message: "Completed reviews require a summary and no error" });
    if (value.status === "failed" && !value.error)
      ctx.addIssue({ code: "custom", message: "Failed reviews require an error" });
  });

/**
 * Poll diagnostics belong to this process, rather than durable workflow state.
 */
export const PollStatusSchema = z.object({
  attemptedAt: z.iso.datetime().optional(),
  successfulAt: z.iso.datetime().optional(),
  nextPollAt: z.iso.datetime().optional(),
  error: z.string().nullable().optional(),
  rateLimit: RateLimitSchema.optional(),
});

/**
 * Canonical persistence and public request shapes.
 */
export type ReviewJob = z.infer<typeof ReviewJobSchema>;
export type ReviewAttempt = z.infer<typeof ReviewAttemptSchema>;
export type ReviewStart = z.infer<typeof ReviewStartSchema>;
export type ReviewFinish = z.infer<typeof ReviewFinishSchema>;
export type PollStatus = z.infer<typeof PollStatusSchema>;
