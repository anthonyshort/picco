import { z } from "zod";
import { CandidateSchema } from "../github.js";

/**
 * Explicit jobs never enter the polling completion ledger or publication claims.
 */
export const JobSchema = CandidateSchema.extend({
  id: z.string(),
  requestId: z.string().min(1),
  source: z.enum(["tool", "mcp"]),
  delivery: z.enum(["local-only", "publish"]),
  base: z.string().regex(/^[a-f0-9]{40}$/),
  reviewer: z.string(),
  skill: z.string(),
  status: z.enum(["queued", "running", "completed", "blocked", "interrupted", "cancelled"]),
  queuedAt: z.iso.datetime(),
  reason: z.string().optional(),
});

/**
 * Each admitted attempt preserves its original commits and request identity.
 */
export const JobRunSchema = JobSchema.omit({ status: true, queuedAt: true }).extend({
  itemId: z.string(),
  jobId: z.string(),
  startedAt: z.iso.datetime(),
  sessionKey: z.string(),
  status: z.enum(["running", "completed", "blocked", "interrupted"]),
  finishedAt: z.iso.datetime().optional(),
  reason: z.string().optional(),
  output: z.string().optional(),
  reviewedAt: z.iso.datetime().optional(),
  reviewSummary: z.string().optional(),
  notification: z.string().optional(),
  notificationError: z.string().optional(),
});

/**
 * Full workflow evidence is separate from bounded diagnostic output.
 */
export const ReviewResultCaptureSchema = z
  .object({
    complete: z.boolean(),
    value: z
      .unknown()
      .refine((value) => z.json().safeParse(value).success, "Review result must be JSON"),
  })
  .strict();

/**
 * New explicit request, validated before persistence.
 */
export const JobSubmissionSchema = JobSchema.pick({
  requestId: true,
  source: true,
  delivery: true,
  base: true,
  reviewer: true,
  skill: true,
}).extend({
  url: z.url(),
  candidate: CandidateSchema,
});

/**
 * Retry refreshes the candidate without changing earlier attempts.
 */
export const JobRetrySchema = z.object({
  candidate: CandidateSchema,
  base: JobSchema.shape.base,
  requestId: z.string().min(1).optional(),
});

/**
 * Worker outcome recorded only after its teardown attempt.
 */
export const JobFinishSchema = z.object({
  status: JobRunSchema.shape.status.exclude(["running"]),
  finishedAt: z.iso.datetime().optional(),
  reason: z.string().optional(),
  abandoned: z.boolean().optional(),
  output: z.string().optional(),
});

/**
 * Durable explicit request and attempt types.
 */
export type Job = z.infer<typeof JobSchema>;
export type JobRun = z.infer<typeof JobRunSchema>;

/**
 * Full or partial JSON evidence retained for an attempt.
 */
export type ReviewResultCapture = z.infer<typeof ReviewResultCaptureSchema>;
