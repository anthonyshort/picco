import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Maximum repository routes accepted by one discovery source.
 */
const MAX_REPOSITORIES = 100;
/**
 * GitHub exposes at most this many results for one search.
 */
const MAX_SEARCH_RESULTS = 1_000;
/**
 * Bound connection pagination while inspecting current requests and their history.
 */
const MAX_INSPECTION_PAGES = 100;
/**
 * Maximum page size supported by the queried GitHub connections.
 */
const PAGE_SIZE = 100;
/**
 * Deadline for one authenticated CLI request.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Bound buffered CLI response data.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/**
 * Milliseconds in one UTC day for rolling creation cutoffs.
 */
const DAY_MS = 86_400_000;
/**
 * Normalised owner/name identity accepted in API paths and search filters.
 */
const RepositorySchema = z
  .string()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
  .transform((value) => value.toLowerCase());
/**
 * GitHub reviewer login, including bot-account notation.
 */
const LoginSchema = z.string().regex(/^[a-z0-9-]+(?:\[bot\])?$/i);
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
const DiscoveryResponseSchema = z.object({
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
const RepositoryAccessSchema = z.object({
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
const InspectionResponseSchema = z.object({
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
 * Safe transport diagnostics with optional rate-limit guidance for the poll loop.
 */
export class GithubReviewSourceError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GithubReviewSourceError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Discover and revalidate personal review requests through GraphQL.
 */
export function createGithubSource(opts: GithubSourceOptions = {}) {
  const execute = opts.execute ?? executeGithub;
  const now = opts.now ?? Date.now;

  async function discover(inputRepositories: string[], maxPrAgeDays: number, signal?: AbortSignal) {
    const repositories = z
      .array(RepositorySchema)
      .min(1)
      .max(MAX_REPOSITORIES)
      .parse(inputRepositories);
    if (new Set(repositories).size !== repositories.length)
      throw new Error("Review repositories must be unique");
    const cutoff = now() - z.number().int().min(1).max(3_650).parse(maxPrAgeDays) * DAY_MS;
    const query = `(${repositories.map((repository) => `repo:${repository}`).join(" OR ")}) is:pr is:open draft:false review-requested:@me created:>=${new Date(cutoff).toISOString().slice(0, 10)}`;
    const repositoryFields = repositories
      .map((repository, index) => {
        const [owner, name] = repository.split("/");
        return `repository${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner pullRequests(first: 1) { totalCount } }`;
      })
      .join("\n");
    const document = `query RequestedReviews($query: String!, $after: String) {
      viewer { login }
      ${repositoryFields}
      search(query: $query, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
        issueCount nodes { ... on PullRequest { number title url headRefOid createdAt isDraft state repository { nameWithOwner } } }
        pageInfo { hasNextPage endCursor }
      }
      rateLimit { cost remaining resetAt }
    }`;
    const found = new Map<string, Candidate>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let reviewer: string | undefined;
    let rateLimit: z.infer<typeof RateLimitSchema> | undefined;
    let totalCost = 0;
    for (let page = 0; page < MAX_SEARCH_RESULTS / PAGE_SIZE; page++) {
      signal?.throwIfAborted();
      const response = DiscoveryResponseSchema.parse(
        JSON.parse(
          await execute(
            ["api", "graphql", "--input", "-"],
            JSON.stringify({ query: document, variables: { query, after } }),
            signal,
          ),
        ),
      );
      if (response.errors?.length || !response.data) {
        const limited = response.errors?.some(
          (error) => z.object({ type: z.literal("RATE_LIMITED") }).safeParse(error).success,
        );
        const retryAfterMs = limited
          ? Math.max(
              60_000,
              response.data ? Date.parse(response.data.rateLimit.resetAt) - now() : 0,
            )
          : undefined;
        throw new GithubReviewSourceError(
          "GitHub GraphQL discovery returned incomplete results",
          retryAfterMs,
        );
      }
      const data = response.data;
      if (reviewer && reviewer.toLowerCase() !== data.viewer.login.toLowerCase())
        throw new Error("GitHub reviewer changed during discovery");
      reviewer = data.viewer.login;
      for (const [index, repository] of repositories.entries()) {
        const access = RepositoryAccessSchema.safeParse(data[`repository${index}`]);
        if (!access.success || access.data.nameWithOwner !== repository)
          throw new Error(`GitHub pull requests are inaccessible for ${repository}`);
      }
      totalCost += data.rateLimit.cost;
      rateLimit = { ...data.rateLimit, cost: totalCost };
      if (data.search.issueCount > MAX_SEARCH_RESULTS)
        throw new Error("GitHub review search exceeds the 1,000-result limit");
      for (const pull of data.search.nodes) {
        const candidate = CandidateSchema.parse({
          repository: pull.repository.nameWithOwner,
          number: pull.number,
          title: pull.title,
          url: pull.url,
          head: pull.headRefOid,
          createdAt: pull.createdAt,
        });
        ensureCandidateUrl(candidate);
        if (!repositories.includes(candidate.repository))
          throw new Error("GitHub discovery returned an unconfigured repository");
        if (pull.isDraft || pull.state !== "OPEN" || Date.parse(candidate.createdAt) < cutoff)
          continue;
        const key = `${candidate.repository}#${candidate.number}`;
        const previous = found.get(key);
        if (previous && previous.head !== candidate.head)
          throw new Error("GitHub review search changed during pagination");
        found.set(key, candidate);
      }
      if (!data.search.pageInfo.hasNextPage) {
        return { reviewer, candidates: [...found.values()].sort(compareCandidates), rateLimit };
      }
      after = data.search.pageInfo.endCursor;
      if (!after || cursors.has(after))
        throw new Error("GitHub discovery returned invalid pagination");
      cursors.add(after);
    }
    throw new Error("GitHub review search could not be completely paginated");
  }

  async function inspect(
    inputCandidate: Candidate,
    inputReviewer: string,
    signal?: AbortSignal,
  ): Promise<Inspection> {
    const candidate = CandidateSchema.parse(inputCandidate);
    ensureCandidateUrl(candidate);
    const reviewer = LoginSchema.parse(inputReviewer).toLowerCase();
    const [owner, name] = candidate.repository.split("/");
    const document = `query InspectReview($owner: String!, $name: String!, $number: Int!, $after: String, $before: String, $includeRequests: Boolean!, $includeTimeline: Boolean!) {
      viewer { login }
      repository(owner: $owner, name: $name) {
        nameWithOwner
        pullRequest(number: $number) {
          number title url createdAt headRefOid isDraft state
          reviewRequests(first: ${PAGE_SIZE}, after: $after) @include(if: $includeRequests) {
            nodes { requestedReviewer { ... on User { login } } }
            pageInfo { hasNextPage endCursor }
          }
          timelineItems(last: ${PAGE_SIZE}, before: $before, itemTypes: [REVIEW_REQUESTED_EVENT]) @include(if: $includeTimeline) {
            nodes { ... on ReviewRequestedEvent { id createdAt requestedReviewer { ... on User { login } } } }
            pageInfo { hasPreviousPage startCursor }
          }
        }
      }
      rateLimit { cost remaining resetAt }
    }`;
    const result: Pick<Inspection, "candidate" | "requestEventId" | "requestedAt"> = { candidate };
    let totalCost = 0;
    const requestCursors = new Set<string>();
    const timelineCursors = new Set<string>();
    const eventIds = new Map<string, string>();
    let after: string | null = null;
    let before: string | null = null;
    let includeRequests = true;
    let includeTimeline = true;
    let personallyRequested = false;
    for (let page = 0; page < MAX_INSPECTION_PAGES; page++) {
      signal?.throwIfAborted();
      const response = InspectionResponseSchema.parse(
        JSON.parse(
          await execute(
            ["api", "graphql", "--input", "-"],
            JSON.stringify({
              query: document,
              variables: {
                owner,
                name,
                number: candidate.number,
                after,
                before,
                includeRequests,
                includeTimeline,
              },
            }),
            signal,
          ),
        ),
      );
      if (response.errors?.length || !response.data) {
        const limited = response.errors?.some(
          (error) => z.object({ type: z.literal("RATE_LIMITED") }).safeParse(error).success,
        );
        const retryAfterMs = limited
          ? Math.max(
              60_000,
              response.data ? Date.parse(response.data.rateLimit.resetAt) - now() : 0,
            )
          : undefined;
        throw new GithubReviewSourceError(
          "GitHub GraphQL inspection returned incomplete results",
          retryAfterMs,
        );
      }
      const data = response.data;
      totalCost += data.rateLimit.cost;
      const rateLimit = { ...data.rateLimit, cost: totalCost };
      if (data.viewer.login.toLowerCase() !== reviewer)
        throw new Error("GitHub reviewer changed during inspection");
      if (!data.repository || data.repository.nameWithOwner !== candidate.repository)
        throw new Error(`GitHub pull requests are inaccessible for ${candidate.repository}`);
      const live = data.repository.pullRequest;
      ensureCandidateUrl({ ...candidate, url: live.url });
      if (live.number !== candidate.number || live.createdAt !== candidate.createdAt)
        throw new Error("GitHub live pull request identity does not match discovery");
      if (live.state !== "OPEN" || live.isDraft)
        return { ...result, rateLimit, blockedReason: "no-longer-ready-for-review" };
      if (live.headRefOid !== candidate.head)
        return { ...result, rateLimit, blockedReason: "head-changed" };
      if (includeRequests) {
        if (!live.reviewRequests)
          throw new Error("GitHub inspection omitted current reviewer requests");
        personallyRequested ||= live.reviewRequests.nodes.some(
          (request) => request.requestedReviewer?.login?.toLowerCase() === reviewer,
        );
        includeRequests = !personallyRequested && live.reviewRequests.pageInfo.hasNextPage;
        if (includeRequests) {
          after = live.reviewRequests.pageInfo.endCursor;
          if (!after || requestCursors.has(after))
            throw new Error("GitHub reviewer requests returned invalid pagination");
          requestCursors.add(after);
        }
      }
      if (!includeRequests && !personallyRequested)
        return { ...result, rateLimit, blockedReason: "review-no-longer-requested" };
      if (includeTimeline) {
        if (!live.timelineItems) throw new Error("GitHub inspection omitted request history");
        for (const event of [...live.timelineItems.nodes].reverse()) {
          if (Date.parse(event.createdAt) > now())
            throw new Error("GitHub review request is dated in the future");
          const identity = JSON.stringify([
            event.createdAt,
            event.requestedReviewer?.login?.toLowerCase(),
          ]);
          if (eventIds.has(event.id) && eventIds.get(event.id) !== identity)
            throw new Error("GitHub returned conflicting review request event IDs");
          eventIds.set(event.id, identity);
          if (
            !result.requestEventId &&
            event.requestedReviewer?.login?.toLowerCase() === reviewer
          ) {
            result.requestEventId = event.id;
            result.requestedAt = event.createdAt;
          }
        }
        includeTimeline = !result.requestEventId && live.timelineItems.pageInfo.hasPreviousPage;
        if (includeTimeline) {
          before = live.timelineItems.pageInfo.startCursor;
          if (!before || timelineCursors.has(before))
            throw new Error("GitHub request history returned invalid pagination");
          timelineCursors.add(before);
        }
      }
      if (!includeRequests && !includeTimeline)
        return InspectionSchema.parse({ ...result, rateLimit });
    }
    throw new Error("GitHub request inspection exceeded the pagination limit");
  }

  return { discover, inspect };
}

/**
 * Run GitHub CLI with bounded output, cancellation and credential-free diagnostics.
 */
function executeGithub(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const retryHeader = /retry-after:\s*(\d+)/i.exec(stderr);
          const retryAfterMs = retryHeader
            ? Math.min(Number(retryHeader[1]) * 1_000, DAY_MS)
            : /rate limit/i.test(stderr)
              ? 60_000
              : undefined;
          reject(
            new GithubReviewSourceError(
              `GitHub request failed (${signal?.aborted ? "cancelled" : "authentication, rate limit, transport or command failure"})`,
              retryAfterMs,
            ),
          );
        } else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/**
 * Enforce repository/number correspondence before using a remote pull request URL.
 */
function ensureCandidateUrl(candidate: Candidate): void {
  const url = new URL(candidate.url);
  if (
    url.origin !== "https://github.com" ||
    url.pathname.toLowerCase() !== `/${candidate.repository}/pull/${candidate.number}` ||
    url.search ||
    url.hash
  )
    throw new Error("GitHub pull request URL does not match its repository and number");
}

/**
 * Preserve global oldest-first review ordering across repository routes.
 */
function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.repository.localeCompare(right.repository) ||
    left.number - right.number
  );
}
