import { z } from "zod";
import {
  LoginSchema,
  PAGE_SIZE,
  RateLimitSchema,
  RepositorySchema,
  type GithubSourceOptions,
} from "./github-contracts.js";
import { executeGithub, GithubReviewSourceError } from "./github-query.js";

/**
 * Bound malformed or unexpectedly large connection scans.
 */
const MAX_PAGES = 10_000;
/**
 * Submitted states that can contain actionable feedback.
 */
const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const;
/**
 * A submitted review retained in the worker's feedback snapshot.
 */
export const FeedbackReviewSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  author: LoginSchema,
  submittedAt: z.iso.datetime(),
  body: z.string(),
  state: z.enum(REVIEW_STATES),
  inlineCommentCount: z.number().int().nonnegative(),
});
/**
 * An authored PR and its currently eligible submitted reviews.
 */
export const FeedbackCandidateSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().positive().safe(),
  url: z.url(),
  title: z.string(),
  head: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .transform((value) => value.toLowerCase()),
  headRepository: RepositorySchema,
  headBranch: z.string().min(1),
  reviews: z.array(FeedbackReviewSchema).max(1_000_000),
});
/**
 * One submitted review used to identify a feedback batch.
 */
export type FeedbackReview = z.infer<typeof FeedbackReviewSchema>;
/**
 * An authored pull request with feedback selected by the host.
 */
export type FeedbackCandidate = z.infer<typeof FeedbackCandidateSchema>;
/**
 * Forward connection pagination shared by authored PRs and reviews.
 */
const PageSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
/**
 * Live metadata includes unavailable fork heads and deleted authors.
 */
const PullSchema = z.object({
  repository: z.object({ nameWithOwner: RepositorySchema }),
  number: FeedbackCandidateSchema.shape.number,
  url: z.url(),
  title: z.string(),
  state: z.string(),
  author: z.object({ login: LoginSchema }).nullable(),
  headRefOid: FeedbackCandidateSchema.shape.head,
  headRepository: z.object({ nameWithOwner: RepositorySchema }).nullable(),
  headRefName: z.string(),
});
/**
 * Identity and API budget returned with every query.
 */
const BaseDataSchema = z.object({
  viewer: z.object({ login: LoginSchema }),
  rateLimit: RateLimitSchema,
});
/**
 * Authored PRs return metadata; reviews are paginated separately.
 */
const DiscoveryDataSchema = BaseDataSchema.extend({
  viewer: BaseDataSchema.shape.viewer.extend({
    pullRequests: z.object({
      nodes: z.array(PullSchema).max(PAGE_SIZE),
      pageInfo: PageSchema,
    }),
  }),
});
/**
 * Review metadata includes unsubmitted and dismissed reviews for explicit filtering.
 */
const ReviewSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  author: z.object({ login: LoginSchema }).nullable(),
  submittedAt: z.iso.datetime().nullable(),
  body: z.string(),
  state: z.string(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }),
});
/**
 * Review wire data includes pending and dismissed reviews for explicit filtering.
 */
const ReviewDataSchema = BaseDataSchema.extend({
  repository: z
    .object({
      nameWithOwner: RepositorySchema,
      pullRequest: PullSchema.extend({
        reviews: z.object({
          nodes: z.array(ReviewSchema).max(PAGE_SIZE),
          pageInfo: PageSchema,
        }),
      }).nullable(),
    })
    .nullable(),
});
/**
 * Reject upstream errors without exposing private diagnostic text.
 */
const EnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).max(100).optional(),
});
/**
 * Repeated metadata detects concurrent changes during review pagination.
 */
const PULL_FIELDS =
  "repository { nameWithOwner } number url title state author { login } headRefOid headRepository { nameWithOwner } headRefName";
/**
 * Cursor pagination covers open authored PRs without a search-result cap.
 */
const DISCOVERY_DOCUMENT = `query AuthoredFeedback($after: String) {
  viewer {
    login
    pullRequests(first: ${PAGE_SIZE}, after: $after, states: [OPEN]) {
      nodes { ${PULL_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;
/**
 * Read the complete submitted review history of one PR.
 */
const REVIEWS_DOCUMENT = `query InspectFeedback($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      ${PULL_FIELDS}
      reviews(first: ${PAGE_SIZE}, after: $after) {
        nodes { id url author { login } submittedAt body state comments(first: 1) { totalCount } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

/**
 * Discover authored PR feedback and revalidate ownership and head before admission.
 */
export function createGithubFeedbackSource(opts: GithubSourceOptions = {}) {
  const execute = opts.execute ?? executeGithub;
  const now = opts.now ?? Date.now;

  async function query<Schema extends z.ZodType>(
    document: string,
    variables: Record<string, unknown>,
    schema: Schema,
    signal?: AbortSignal,
  ): Promise<z.output<Schema>> {
    signal?.throwIfAborted();
    const envelope = EnvelopeSchema.parse(
      JSON.parse(
        await execute(
          ["api", "graphql", "--input", "-"],
          JSON.stringify({ query: document, variables }),
          signal,
        ),
      ),
    );
    if (envelope.errors?.length || !envelope.data) {
      const limited = envelope.errors?.some(
        (error) => z.object({ type: z.literal("RATE_LIMITED") }).safeParse(error).success,
      );
      const budget = z.object({ rateLimit: RateLimitSchema }).safeParse(envelope.data);
      throw new GithubReviewSourceError(
        "GitHub feedback query returned incomplete results",
        limited
          ? Math.max(60_000, budget.success ? Date.parse(budget.data.rateLimit.resetAt) - now() : 0)
          : undefined,
      );
    }
    return schema.parse(envelope.data);
  }

  async function inspect(candidate: FeedbackCandidate, author: string, signal?: AbortSignal) {
    const selected = FeedbackCandidateSchema.parse(candidate);
    ensureUrl(selected);
    const identity = LoginSchema.parse(author).toLowerCase();
    const [owner, name] = selected.repository.split("/");
    const reviews = new Map<string, FeedbackReview>();
    const pages = paginate(
      (after) =>
        query(
          REVIEWS_DOCUMENT,
          { owner, name, number: selected.number, after },
          ReviewDataSchema,
          signal,
        ),
      (data) => data.repository?.pullRequest?.reviews.pageInfo,
      identity,
    );
    for await (const { data, rateLimit } of pages) {
      const pull = data.repository?.pullRequest;
      if (!data.repository || data.repository.nameWithOwner !== selected.repository || !pull)
        return { candidate: selected, blockedReason: "pull-request-unavailable", rateLimit };
      const live = createCandidate(pull, identity);
      if (!live)
        return { candidate: selected, blockedReason: "no-longer-open-or-owned", rateLimit };
      if (live.repository !== selected.repository || live.number !== selected.number)
        throw new Error("GitHub feedback inspection returned another pull request");
      if (
        live.head !== selected.head ||
        live.headRepository !== selected.headRepository ||
        live.headBranch !== selected.headBranch
      )
        return { candidate: selected, blockedReason: "head-changed", rateLimit };
      for (const review of pull.reviews.nodes) {
        const feedback = createFeedbackReview(review, identity);
        if (!feedback) continue;
        const previous = reviews.get(feedback.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(feedback))
          throw new Error("GitHub returned conflicting review IDs");
        reviews.set(feedback.id, feedback);
      }
      if (!pull.reviews.pageInfo.hasNextPage)
        return {
          candidate: {
            ...live,
            reviews: [...reviews.values()].sort(
              (left, right) =>
                left.submittedAt.localeCompare(right.submittedAt) ||
                left.id.localeCompare(right.id),
            ),
          },
          rateLimit,
        };
    }
    throw new Error("GitHub feedback review pagination exceeded its limit");
  }

  async function discoverPullRequests(signal?: AbortSignal) {
    const found = new Map<string, FeedbackCandidate>();
    const pages = paginate(
      (after) => query(DISCOVERY_DOCUMENT, { after }, DiscoveryDataSchema, signal),
      (data) => data.viewer.pullRequests.pageInfo,
    );
    for await (const { data, author, rateLimit } of pages) {
      for (const pull of data.viewer.pullRequests.nodes) {
        const candidate = createCandidate(pull, author);
        if (!candidate) continue;
        const key = `${candidate.repository}#${candidate.number}`;
        const previous = found.get(key);
        if (previous && previous.head !== candidate.head)
          throw new Error("GitHub feedback discovery changed during pagination");
        found.set(key, candidate);
      }
      if (!data.viewer.pullRequests.pageInfo.hasNextPage)
        return {
          author,
          candidates: [...found.values()],
          rateLimit,
        };
    }
    throw new Error("GitHub feedback discovery pagination exceeded its limit");
  }

  async function discover(signal?: AbortSignal) {
    const found = await discoverPullRequests(signal);
    const { author } = found;
    let budget = found.rateLimit;
    let cost = budget.cost;
    const candidates: FeedbackCandidate[] = [];
    for (const candidate of found.candidates) {
      const inspected = await inspect(candidate, author, signal);
      cost += inspected.rateLimit.cost;
      budget = inspected.rateLimit;
      if (!inspected.blockedReason && inspected.candidate.reviews.length)
        candidates.push(inspected.candidate);
    }
    candidates.sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) || left.number - right.number,
    );
    return { author, candidates, rateLimit: { ...budget, cost } };
  }

  return { discover, inspect };
}

/**
 * Reject routing errors before a worker receives a remote URL.
 */
function ensureUrl(candidate: FeedbackCandidate) {
  const url = new URL(candidate.url);
  if (
    url.origin !== "https://github.com" ||
    url.pathname.toLowerCase() !== `/${candidate.repository}/pull/${candidate.number}` ||
    url.search ||
    url.hash
  )
    throw new Error("GitHub feedback URL does not match its pull request");
}

/**
 * Filter closed, unowned and unavailable heads, retaining drafts.
 */
function createCandidate(
  pull: z.infer<typeof PullSchema>,
  author: string,
): FeedbackCandidate | undefined {
  if (
    pull.state !== "OPEN" ||
    pull.author?.login.toLowerCase() !== author ||
    !pull.headRepository ||
    !pull.headRefName
  )
    return undefined;
  const candidate = FeedbackCandidateSchema.parse({
    repository: pull.repository.nameWithOwner,
    number: pull.number,
    url: pull.url,
    title: pull.title,
    head: pull.headRefOid,
    headRepository: pull.headRepository.nameWithOwner,
    headBranch: pull.headRefName,
    reviews: [],
  });
  ensureUrl(candidate);
  return candidate;
}

/**
 * Authentication must remain stable across every page of a scan.
 */
function ensureAuthor(actual: string, expected: string) {
  if (actual.toLowerCase() !== expected)
    throw new Error("Authenticated GitHub author changed during feedback discovery");
}

/**
 * Keep account identity and API cost consistent while following connection cursors.
 */
async function* paginate<Data extends z.infer<typeof BaseDataSchema>>(
  loadPage: (after: string | null) => Promise<Data>,
  getPageInfo: (data: Data) => z.infer<typeof PageSchema> | undefined,
  author?: string,
) {
  const cursors = new Set<string>();
  let after: string | null = null;
  let cost = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await loadPage(after);
    author ??= data.viewer.login.toLowerCase();
    ensureAuthor(data.viewer.login, author);
    cost += data.rateLimit.cost;
    yield { data, author, rateLimit: { ...data.rateLimit, cost } };

    const pageInfo = getPageInfo(data);
    if (!pageInfo?.hasNextPage) return;
    if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor))
      throw new Error("GitHub feedback returned invalid pagination");
    cursors.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
  }
  throw new Error("GitHub feedback pagination exceeded its limit");
}

/**
 * Retain submitted feedback from other authors, excluding empty approvals.
 */
function createFeedbackReview(
  review: z.infer<typeof ReviewSchema>,
  author: string,
): FeedbackReview | undefined {
  if (!review.author || review.author.login.toLowerCase() === author || !review.submittedAt)
    return undefined;
  const state = FeedbackReviewSchema.shape.state.safeParse(review.state);
  if (!state.success) return undefined;
  if (state.data === "APPROVED" && !review.body.trim() && !review.comments.totalCount)
    return undefined;
  return FeedbackReviewSchema.parse({
    ...review,
    author: review.author.login,
    state: state.data,
    inlineCommentCount: review.comments.totalCount,
  });
}
