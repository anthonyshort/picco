import { z } from "zod";
import { CandidateSchema } from "../github.js";

/**
 * Persisted queue lifecycle states.
 */
export const QUEUE_STATES = ["queued", "running", "completed", "blocked", "superseded"] as const;

/**
 * Persisted execution outcomes.
 */
export const RUN_STATES = ["running", "completed", "blocked", "interrupted"] as const;

/**
 * Current candidate state with refreshed request-cycle evidence.
 */
export const QueueItemSchema = CandidateSchema.extend({
  id: z.string(),
  reviewer: z.string(),
  status: z.enum(QUEUE_STATES),
  reason: z.string().nullable(),
  requestEventId: z.string().min(1).nullable(),
  requestedAt: z.iso.datetime().nullable(),
  seenAt: z.number().int(),
});

/**
 * Immutable review admission identity and its durable execution outcome.
 */
export const StoreRunSchema = CandidateSchema.extend({
  id: z.string(),
  itemId: z.string(),
  reviewer: z.string(),
  requestEventId: z.string().min(1).optional(),
  requestedAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime(),
  sessionKey: z.string(),
});

/**
 * Durable run completion supplied after worker teardown.
 */
export const OutcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "interrupted"]),
  reason: z.string().optional(),
  output: z.string().optional(),
});

/**
 * Recorded result of a polling attempt.
 */
export const PollUpdateSchema = z.object({
  attemptedAt: z.iso.datetime(),
  successfulAt: z.iso.datetime().optional(),
  nextPollAt: z.iso.datetime().optional(),
  error: z.string().nullable().optional(),
  rateLimit: z
    .object({ cost: z.number(), remaining: z.number(), resetAt: z.iso.datetime() })
    .optional(),
});

/**
 * One candidate currently observed for the authenticated reviewer.
 */
export type QueueItem = z.infer<typeof QueueItemSchema>;

/**
 * Immutable identity of an admitted review attempt.
 */
export type StoreRun = z.infer<typeof StoreRunSchema>;

/**
 * Durable outcome supplied after worker teardown.
 */
export type ReviewOutcome = z.infer<typeof OutcomeSchema>;

/**
 * Poll result persisted for status after restart.
 */
export type PollUpdate = z.infer<typeof PollUpdateSchema>;
