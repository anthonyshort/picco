import * as z from "zod";

/**
 * GitHub IDs are kept as decimal strings by the workflow.
 */
export const CommentIdSchema = z
  .string()
  .max(32)
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

/**
 * Repositories determine API paths; reject traversal segments before constructing them.
 */
export const PullRequestSchema = z.object({
  repository: z
    .string()
    .max(200)
    .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
    .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."))
    .transform((value) => value.toLowerCase()),
  pullRequest: z.number().int().positive().safe(),
});

/**
 * Native GitHub Markdown is sent unchanged within its comment limit.
 */
export const BodySchema = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0);

/**
 * Pin reviews and diff comments to an inspected revision when available.
 */
export const CommitIdSchema = z.string().regex(/^[a-f0-9]{40}$/i);

/**
 * One diff location, optionally spanning a range across either side.
 */
export const InlineCommentSchema = z
  .object({
    body: BodySchema,
    path: z.string().min(1).max(1000),
    line: z.number().int().positive().safe(),
    side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
    startLine: z.number().int().positive().safe().optional(),
    startSide: z.enum(["LEFT", "RIGHT"]).optional(),
  })
  .strict()
  .refine(
    (value) => (value.startLine === undefined) === (value.startSide === undefined),
    "Supply startLine and startSide together",
  )
  .refine(
    (value) =>
      value.startLine === undefined ||
      value.startSide !== value.side ||
      value.startLine <= value.line,
    "The range must end after it starts on the same side",
  );

/**
 * Extract the response identity without returning provider diagnostics or private profile data.
 */
export const ResourceSchema = z.object({ id: z.number().int().positive().safe() });

/**
 * Convert the shared diff location to GitHub's field names.
 */
export function inlinePayload(input: z.infer<typeof InlineCommentSchema>) {
  return {
    body: input.body,
    path: input.path,
    line: input.line,
    side: input.side,
    start_line: input.startLine,
    start_side: input.startSide,
  };
}
