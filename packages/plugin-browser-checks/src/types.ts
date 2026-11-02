import { z } from "zod";
import type { PiOptions, Plugin, Tool, ToolContext } from "@picco-agent/core";

const text = z.string().trim().min(1).max(4000);
const revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

/**
 * A bounded question submitted by an authorised caller.
 */
export const BrowserRequestSchema = z
  .strictObject({
    requestKey: z.string().trim().min(1).max(200),
    profile: z.string().trim().min(1).max(100),
    question: text,
    expected: text,
    url: z.url().max(2000).optional(),
    source: text.optional(),
    revision: revision.optional(),
    context: z.string().max(12000).default(""),
    video: z.boolean().default(false),
  })
  .refine((value) => value.url !== undefined || value.source !== undefined, {
    message: "Supply a target URL or source reference",
  });

/**
 * Prepared instructions accepted before any remote browser execution.
 */
export const BrowserPlanSchema = z.strictObject({
  url: z.url().max(2000),
  steps: z.array(text).min(1).max(25),
  expected: text,
  setup: z.string().max(4000),
});

/**
 * Evidence produced by the configured Atlas tester.
 */
export const BrowserEvidenceSchema = z.strictObject({
  url: z.url().max(2000),
  revision: revision.nullable(),
  revisionEvidence: z.string().max(4000),
  observations: z.array(text).max(30),
  limits: z.array(text).max(20),
  artifacts: z
    .array(
      z.strictObject({
        kind: z.enum(["screenshot", "video"]),
        url: z.url().max(2000),
      }),
    )
    .max(10),
});

/**
 * Local copies of evidence verified through an authorised download path.
 */
export const BrowserArtifactSchema = z.strictObject({
  kind: z.enum(["screenshot", "video"]),
  source: z.url().max(2000),
  file: z.string().min(1),
  bytes: z.number().int().positive(),
  mimeType: z.string().min(1),
});

/**
 * A narrow answer; product failures are evidence rather than execution errors.
 */
export const BrowserResultSchema = z.strictObject({
  answer: z.enum(["supported", "contradicted", "inconclusive"]),
  summary: text,
  observations: z.array(text).max(30),
  limits: z.array(text).max(20),
});

/**
 * Persisted job snapshots delivered at least once to the application.
 */
export const BrowserJobSchema = z.strictObject({
  id: z.uuid(),
  owner: z.string().min(1),
  request: BrowserRequestSchema,
  state: z.enum([
    "queued",
    "preparing",
    "launching",
    "running",
    "assessing",
    "complete",
    "blocked",
    "failed",
    "cancelled",
    "timed-out",
    "uncertain",
  ]),
  version: z.number().int().positive(),
  createdAt: z.number(),
  deadline: z.number(),
  updatedAt: z.number(),
  dispatchKey: z.uuid(),
  configuration: z.string().nullable(),
  plan: BrowserPlanSchema.nullable(),
  remote: z.strictObject({ runId: z.string().min(1), threadId: z.string().min(1) }).nullable(),
  remoteStopped: z.boolean().nullable(),
  evidence: BrowserEvidenceSchema.nullable(),
  artifacts: z.array(BrowserArtifactSchema).max(10),
  result: BrowserResultSchema.nullable(),
  error: z.string().max(4000).nullable(),
});

export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>;
export type BrowserEvidence = z.infer<typeof BrowserEvidenceSchema>;
export type BrowserArtifact = z.infer<typeof BrowserArtifactSchema>;
export type BrowserResult = z.infer<typeof BrowserResultSchema>;
export type BrowserJob = z.infer<typeof BrowserJobSchema>;

/**
 * Environment guidance and read tools supplied by the application, never by model input.
 */
export interface BrowserProfile {
  origins: string[];
  instructions: string;
  tools?: Tool[];
}

/**
 * Host-owned configuration; no publishing destination or credential is accepted in a request.
 */
export interface BrowserChecksOptions {
  atlas: {
    url: string;
    token: string;
    workflow: string;
    resultNode?: string;
    fetch?: typeof fetch;
  };
  profiles: Record<string, BrowserProfile>;
  allowedSources?: string[];
  pi?: Partial<PiOptions>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onUpdate?: (job: BrowserJob, signal: AbortSignal) => void | Promise<void>;
}

/**
 * Host operations use the same service as the session tools.
 */
export interface BrowserChecks extends Plugin {
  checks: {
    start(request: z.input<typeof BrowserRequestSchema>): BrowserJob;
    status(id: string): BrowserJob;
    cancel(id: string): Promise<BrowserJob>;
  };
}

/**
 * The bridge supplies the caller; request text cannot choose job ownership.
 */
export function browserCaller(ctx: Pick<ToolContext, "caller">): string {
  switch (ctx.caller.kind) {
    case "host":
      return "host";
    case "session":
      return JSON.stringify(ctx.caller.ref);
    default:
      throw new Error("Unsupported browser-check caller");
  }
}
