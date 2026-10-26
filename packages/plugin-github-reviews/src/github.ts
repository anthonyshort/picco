import { z } from "zod";
import {
  CandidateSchema,
  InspectionSchema,
  LoginSchema,
  PAGE_SIZE,
  RepositoryAccessSchema,
  RepositorySchema,
  type Candidate,
  type DiscoveryData,
  type GithubSourceOptions,
  type Inspection,
  type InspectionData,
  type RequestHistoryPage,
  type ReviewerRequestsPage,
} from "./github-contracts.js";
import {
  buildDiscoveryDocument,
  executeGithub,
  readDiscoveryPage,
  readInspectionPage,
} from "./github-query.js";

export { CandidateSchema, InspectionSchema, RateLimitSchema } from "./github-contracts.js";
export type {
  Candidate,
  GithubExecute,
  GithubSourceOptions,
  Inspection,
} from "./github-contracts.js";
export { GithubReviewSourceError } from "./github-query.js";

/**
 * Maximum repository routes accepted by one discovery source.
 */
const MAX_REPOSITORIES = 100;
/**
 * GitHub exposes at most this many results for one search.
 */
const MAX_SEARCH_RESULTS = 1_000;
/**
 * Bound the combined requests/history inspection loop.
 */
const MAX_INSPECTION_PAGES = 100;
/**
 * Milliseconds in one UTC day for rolling creation cutoffs.
 */
const DAY_MS = 86_400_000;

/**
 * Discover and revalidate personal review requests through GraphQL.
 */
export function createGithubSource(opts: GithubSourceOptions = {}) {
  const deps = { execute: opts.execute ?? executeGithub, now: opts.now ?? Date.now };

  async function discover(inputRepositories: string[], maxPrAgeDays: number, signal?: AbortSignal) {
    const repositories = z
      .array(RepositorySchema)
      .min(1)
      .max(MAX_REPOSITORIES)
      .parse(inputRepositories);
    if (new Set(repositories).size !== repositories.length)
      throw new Error("Review repositories must be unique");
    const cutoff = deps.now() - z.number().int().min(1).max(3_650).parse(maxPrAgeDays) * DAY_MS;
    const query = `(${repositories.map((repository) => `repo:${repository}`).join(" OR ")}) is:pr is:open draft:false review-requested:@me created:>=${new Date(cutoff).toISOString().slice(0, 10)}`;
    const document = buildDiscoveryDocument(repositories);
    const collection = createDiscoveryCollection(repositories, cutoff);
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_SEARCH_RESULTS / PAGE_SIZE; page++) {
      const data = await readDiscoveryPage(deps, document, query, after, signal);
      const result = collection.accept(data);
      if (!data.search.pageInfo.hasNextPage)
        return { ...result, candidates: collection.sortedCandidates() };
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
    const requests = createReviewerRequests(reviewer);
    const history = createRequestHistory(reviewer, deps.now);
    let totalCost = 0;
    for (let page = 0; page < MAX_INSPECTION_PAGES; page++) {
      const data = await readInspectionPage(
        deps,
        {
          owner,
          name,
          number: candidate.number,
          after: requests.cursor,
          before: history.cursor,
          includeRequests: !requests.done,
          includeTimeline: !history.done,
        },
        signal,
      );
      totalCost += data.rateLimit.cost;
      const result = {
        candidate,
        ...history.evidence,
        rateLimit: { ...data.rateLimit, cost: totalCost },
      };
      const { live, blockedReason } = inspectLiveCandidate(data, candidate, reviewer);
      if (blockedReason) return { ...result, blockedReason };
      requests.advance(live.reviewRequests);
      if (requests.done && !requests.found)
        return { ...result, blockedReason: "review-no-longer-requested" };
      history.advance(live.timelineItems);
      if (requests.done && history.done)
        return InspectionSchema.parse({ ...result, ...history.evidence });
    }
    throw new Error("GitHub request inspection exceeded the pagination limit");
  }

  return { discover, inspect };
}

/**
 * Collect validated pages without exposing partial discovery results.
 */
function createDiscoveryCollection(repositories: string[], cutoff: number) {
  const found = new Map<string, Candidate>();
  let reviewer: string | undefined;
  let totalCost = 0;

  function accept(data: DiscoveryData) {
    if (reviewer && reviewer.toLowerCase() !== data.viewer.login.toLowerCase())
      throw new Error("GitHub reviewer changed during discovery");
    reviewer = data.viewer.login;
    for (const [index, repository] of repositories.entries()) {
      const access = RepositoryAccessSchema.safeParse(data[`repository${index}`]);
      if (!access.success || access.data.nameWithOwner !== repository)
        throw new Error(`GitHub pull requests are inaccessible for ${repository}`);
    }
    totalCost += data.rateLimit.cost;
    if (data.search.issueCount > MAX_SEARCH_RESULTS)
      throw new Error("GitHub review search exceeds the 1,000-result limit");
    for (const pull of data.search.nodes) {
      const candidate = discoveryCandidate(pull, repositories, cutoff);
      if (!candidate) continue;
      const key = `${candidate.repository}#${candidate.number}`;
      const previous = found.get(key);
      if (previous && previous.head !== candidate.head)
        throw new Error("GitHub review search changed during pagination");
      found.set(key, candidate);
    }
    return {
      reviewer,
      rateLimit: { ...data.rateLimit, cost: totalCost },
    };
  }

  return {
    accept,
    sortedCandidates: () => [...found.values()].sort(compareCandidates),
  };
}

/**
 * Validate result routing before applying local eligibility filters.
 */
function discoveryCandidate(
  pull: DiscoveryData["search"]["nodes"][number],
  repositories: string[],
  cutoff: number,
) {
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
    return undefined;
  return candidate;
}

/**
 * Revalidate live identity and eligibility on every combined connection response.
 */
function inspectLiveCandidate(data: InspectionData, candidate: Candidate, reviewer: string) {
  if (data.viewer.login.toLowerCase() !== reviewer)
    throw new Error("GitHub reviewer changed during inspection");
  if (!data.repository || data.repository.nameWithOwner !== candidate.repository)
    throw new Error(`GitHub pull requests are inaccessible for ${candidate.repository}`);
  const live = data.repository.pullRequest;
  ensureCandidateUrl({ ...candidate, url: live.url });
  if (live.number !== candidate.number || live.createdAt !== candidate.createdAt)
    throw new Error("GitHub live pull request identity does not match discovery");
  const blockedReason =
    live.state !== "OPEN" || live.isDraft
      ? "no-longer-ready-for-review"
      : live.headRefOid !== candidate.head
        ? "head-changed"
        : undefined;
  return { live, blockedReason };
}

/**
 * Own the forward scan until a personal request is found or the connection ends.
 */
function createReviewerRequests(reviewer: string) {
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let done = false;
  let found = false;

  function advance(page: ReviewerRequestsPage | undefined) {
    if (done) return;
    if (!page) throw new Error("GitHub inspection omitted current reviewer requests");
    found = page.nodes.some(
      (request) => request.requestedReviewer?.login?.toLowerCase() === reviewer,
    );
    done = found || !page.pageInfo.hasNextPage;
    if (done) return;
    cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub reviewer requests returned invalid pagination");
    cursors.add(cursor);
  }

  return {
    advance,
    get cursor() {
      return cursor;
    },
    get done() {
      return done;
    },
    get found() {
      return found;
    },
  };
}

/**
 * Own the backward history scan and retain the newest matching request evidence.
 */
function createRequestHistory(reviewer: string, now: () => number) {
  const cursors = new Set<string>();
  const eventIds = new Map<string, string>();
  let cursor: string | null = null;
  let done = false;
  const evidence: Pick<Inspection, "requestEventId" | "requestedAt"> = {};

  function advance(page: RequestHistoryPage | undefined) {
    if (done) return;
    if (!page) throw new Error("GitHub inspection omitted request history");
    for (const event of [...page.nodes].reverse()) {
      if (Date.parse(event.createdAt) > now())
        throw new Error("GitHub review request is dated in the future");
      const identity = JSON.stringify([
        event.createdAt,
        event.requestedReviewer?.login?.toLowerCase(),
      ]);
      if (eventIds.has(event.id) && eventIds.get(event.id) !== identity)
        throw new Error("GitHub returned conflicting review request event IDs");
      eventIds.set(event.id, identity);
      if (!evidence.requestEventId && event.requestedReviewer?.login?.toLowerCase() === reviewer) {
        evidence.requestEventId = event.id;
        evidence.requestedAt = event.createdAt;
      }
    }
    done = !!evidence.requestEventId || !page.pageInfo.hasPreviousPage;
    if (done) return;
    cursor = page.pageInfo.startCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub request history returned invalid pagination");
    cursors.add(cursor);
  }

  return {
    advance,
    evidence,
    get cursor() {
      return cursor;
    },
    get done() {
      return done;
    },
  };
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
