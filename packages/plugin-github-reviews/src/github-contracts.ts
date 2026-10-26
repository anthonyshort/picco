import { z } from "zod";

/**
 * Maximum page size supported by the queried GitHub connections.
 */
export const PAGE_SIZE = 100;

/**
 * Normalised owner/name identity accepted in API paths and search filters.
 */
export const RepositorySchema = z
  .string()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
  .transform((value) => value.toLowerCase());
/**
 * GitHub reviewer login, including bot-account notation.
 */
export const LoginSchema = z.string().regex(/^[a-z0-9-]+(?:\[bot\])?$/i);
/**
 * Normalised commit identity used to detect changed heads.
 */
const HeadSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
/**
 * UTC GitHub evidence timestamps with at most millisecond precision.
 */
const TimeSchema = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

/**
 * A requested pull request discovered for the authenticated reviewer.
 */
export const CandidateSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().positive().safe(),
  title: z.string(),
  url: z.url(),
  head: HeadSchema,
  createdAt: TimeSchema,
});

/**
 * Latest API budget plus aggregate discovery cost for a complete scan.
 */
export const RateLimitSchema = z.object({
  cost: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: TimeSchema,
});
/**
 * Live eligibility evidence, including the latest direct personal request.
 */
export const InspectionSchema = z.object({
  candidate: CandidateSchema,
  requestEventId: z.string().min(1).max(512).optional(),
  requestedAt: TimeSchema.optional(),
  blockedReason: z.string().optional(),
  rateLimit: RateLimitSchema,
});

/**
 * Fields returned by one GraphQL pull request search result.
 */
const PullSchema = z.object({
  number: CandidateSchema.shape.number,
  title: z.string(),
  url: z.url(),
  headRefOid: HeadSchema,
  createdAt: TimeSchema,
  isDraft: z.boolean(),
  state: z.string(),
  repository: z.object({ nameWithOwner: RepositorySchema }),
});
/**
 * Complete GraphQL discovery response, including query-level errors.
 */
export const DiscoveryResponseSchema = z.object({
  errors: z.array(z.unknown()).max(100).optional(),
  data: z
    .object({
      viewer: z.object({ login: LoginSchema }),
      search: z.object({
        issueCount: z.number().int().nonnegative(),
        nodes: z.array(PullSchema).max(PAGE_SIZE),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
      rateLimit: RateLimitSchema,
    })
    .passthrough()
    .nullable()
    .optional(),
});
/**
 * Explicit repository and pull-request access probe.
 */
export const RepositoryAccessSchema = z.object({
  nameWithOwner: RepositorySchema,
  pullRequests: z.object({ totalCount: z.number().int().nonnegative() }),
});
/**
 * Direct user requests have a login; teams and missing historical actors do not.
 */
const RequestedReviewerSchema = z.object({ login: LoginSchema.optional() }).nullable();
/**
 * Current requests and targeted timeline evidence returned by GraphQL inspection.
 */
export const InspectionResponseSchema = z.object({
  errors: z.array(z.unknown()).max(100).optional(),
  data: z
    .object({
      viewer: z.object({ login: LoginSchema }),
      repository: z
        .object({
          nameWithOwner: RepositorySchema,
          pullRequest: z.object({
            number: CandidateSchema.shape.number,
            title: z.string(),
            url: z.url(),
            createdAt: TimeSchema,
            headRefOid: HeadSchema,
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
            isDraft: z.boolean(),
            reviewRequests: z
              .object({
                nodes: z
                  .array(z.object({ requestedReviewer: RequestedReviewerSchema }))
                  .max(PAGE_SIZE),
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              })
              .optional(),
            timelineItems: z
              .object({
                nodes: z
                  .array(
                    z.object({
                      id: z.string().min(1).max(512),
                      createdAt: TimeSchema,
                      requestedReviewer: RequestedReviewerSchema,
                    }),
                  )
                  .max(PAGE_SIZE),
                pageInfo: z.object({
                  hasPreviousPage: z.boolean(),
                  startCursor: z.string().nullable(),
                }),
              })
              .optional(),
          }),
        })
        .nullable(),
      rateLimit: RateLimitSchema,
    })
    .nullable()
    .optional(),
});

/**
 * A pull request identity and the head observed by discovery.
 */
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * Live evidence for one candidate, before local completion checks.
 */
export type Inspection = z.infer<typeof InspectionSchema>;

/**
 * Execute the authenticated GitHub CLI without shell interpolation.
 */
export type GithubExecute = (
  args: string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Source dependencies; omitted transport uses the host's GitHub CLI sign-in.
 */
export interface GithubSourceOptions {
  execute?: GithubExecute;
  now?: () => number;
}

/**
 * Validated fields returned by one discovery page.
 */
export type DiscoveryData = NonNullable<z.infer<typeof DiscoveryResponseSchema>["data"]>;

/**
 * Validated fields returned by one inspection page.
 */
export type InspectionData = NonNullable<z.infer<typeof InspectionResponseSchema>["data"]>;

/**
 * One current-reviewer connection page.
 */
export type ReviewerRequestsPage = NonNullable<
  NonNullable<InspectionData["repository"]>["pullRequest"]["reviewRequests"]
>;

/**
 * One backward request-history connection page.
 */
export type RequestHistoryPage = NonNullable<
  NonNullable<InspectionData["repository"]>["pullRequest"]["timelineItems"]
>;

/**
 * Source dependencies resolved by the public factory.
 */
export type GithubSourceDependencies = Required<GithubSourceOptions>;
