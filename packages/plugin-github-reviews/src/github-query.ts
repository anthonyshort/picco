import { execFile } from "node:child_process";
import { z } from "zod";
import {
  PAGE_SIZE,
  DiscoveryResponseSchema,
  InspectionResponseSchema,
  type GithubExecute,
  type GithubSourceDependencies,
} from "./github-contracts.js";

/**
 * Deadline for one authenticated CLI request.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Bound buffered CLI response data.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/**
 * Cap server retry guidance at one day.
 */
const MAX_RETRY_DELAY_MS = 86_400_000;
/**
 * Minimum delay after a GraphQL rate-limit response.
 */
const MIN_RATE_LIMIT_DELAY_MS = 60_000;
/**
 * Fetch both inspection connections together, omitting either once it is complete.
 */
const INSPECTION_DOCUMENT = `query InspectReview($owner: String!, $name: String!, $number: Int!, $after: String, $before: String, $includeRequests: Boolean!, $includeTimeline: Boolean!) {
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

/**
 * Validated envelopes accepted by the two source operations.
 */
type QueryResponse =
  | z.infer<typeof DiscoveryResponseSchema>
  | z.infer<typeof InspectionResponseSchema>;

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
 * Read a discovery page with operation-specific schema and failure diagnostics.
 */
export async function readDiscoveryPage(
  deps: GithubSourceDependencies,
  document: string,
  query: string,
  after: string | null,
  signal?: AbortSignal,
) {
  const body = await executeQuery(deps.execute, document, { query, after }, signal);
  return ensureCompleteData(DiscoveryResponseSchema.parse(body), "discovery", deps.now);
}

/**
 * Read the currently needed inspection connections in one query.
 */
export async function readInspectionPage(
  deps: GithubSourceDependencies,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const body = await executeQuery(deps.execute, INSPECTION_DOCUMENT, variables, signal);
  return ensureCompleteData(InspectionResponseSchema.parse(body), "inspection", deps.now);
}

/**
 * Keep discovery's repository access probes in the same query as search.
 */
export function buildDiscoveryDocument(repositories: string[]): string {
  const repositoryFields = repositories
    .map((repository, index) => {
      const [owner, name] = repository.split("/");
      return `repository${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner pullRequests(first: 1) { totalCount } }`;
    })
    .join("\n");
  return `query RequestedReviews($query: String!, $after: String) {
    viewer { login }
    ${repositoryFields}
    search(query: $query, type: ISSUE_ADVANCED, first: ${PAGE_SIZE}, after: $after) {
      issueCount nodes { ... on PullRequest { number title url headRefOid createdAt isDraft state repository { nameWithOwner } } }
      pageInfo { hasNextPage endCursor }
    }
    rateLimit { cost remaining resetAt }
  }`;
}

/**
 * Run GitHub CLI with bounded output, cancellation and credential-free diagnostics.
 */
export function executeGithub(
  args: string[],
  input?: string,
  signal?: AbortSignal,
): Promise<string> {
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
            ? Math.min(Number(retryHeader[1]) * 1_000, MAX_RETRY_DELAY_MS)
            : /rate limit/i.test(stderr)
              ? MIN_RATE_LIMIT_DELAY_MS
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
 * Execute an upstream GraphQL envelope without shell interpolation.
 */
async function executeQuery(
  execute: GithubExecute,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return JSON.parse(
    await execute(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }), signal),
  );
}

/**
 * Reject partial data without exposing upstream private error messages.
 */
function ensureCompleteData<Response extends QueryResponse>(
  response: Response,
  operation: string,
  now: () => number,
): NonNullable<Response["data"]> {
  if (response.errors?.length || !response.data) {
    const limited = response.errors?.some(
      (error) => z.object({ type: z.literal("RATE_LIMITED") }).safeParse(error).success,
    );
    const retryAfterMs = limited
      ? Math.max(
          MIN_RATE_LIMIT_DELAY_MS,
          response.data ? Date.parse(response.data.rateLimit.resetAt) - now() : 0,
        )
      : undefined;
    throw new GithubReviewSourceError(
      `GitHub GraphQL ${operation} returned incomplete results`,
      retryAfterMs,
    );
  }
  return response.data;
}
