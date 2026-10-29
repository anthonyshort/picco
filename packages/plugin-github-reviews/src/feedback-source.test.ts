import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { createGithubFeedbackSource, type FeedbackCandidate } from "./feedback-source.js";
import { GithubReviewSourceError } from "./github-query.js";

const head = "a".repeat(40);
const budget = { cost: 1, remaining: 4000, resetAt: "2026-01-02T00:00:00Z" };
const pageInfo = { hasNextPage: false, endCursor: null };
const pull = {
  repository: { nameWithOwner: "example/project" },
  number: 42,
  url: "https://github.com/example/project/pull/42",
  title: "An old draft",
  state: "OPEN",
  author: { login: "Owner" },
  headRefOid: head,
  headRepository: { nameWithOwner: "owner/project" },
  headRefName: "feature",
};
const candidate: FeedbackCandidate = {
  repository: "example/project",
  number: 42,
  url: pull.url,
  title: pull.title,
  head,
  headRepository: "owner/project",
  headBranch: "feature",
  reviews: [],
};
const review = {
  id: "R_one",
  url: `${pull.url}#pullrequestreview-1`,
  author: { login: "Reviewer" },
  submittedAt: "2026-01-01T00:00:00Z",
  body: "Please fix the edge case",
  state: "COMMENTED",
  comments: { totalCount: 0 },
};
const RequestSchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

function discoveryResponse(
  nodes = [pull],
  pagination: { hasNextPage: boolean; endCursor: string | null } = pageInfo,
) {
  return {
    data: {
      viewer: { login: "Owner", pullRequests: { nodes, pageInfo: pagination } },
      rateLimit: budget,
    },
  };
}

function reviewsResponse(
  nodes: unknown[] = [review],
  pagination: { hasNextPage: boolean; endCursor: string | null } = pageInfo,
  metadata = pull,
) {
  return {
    data: {
      viewer: { login: "Owner" },
      rateLimit: budget,
      repository: {
        nameWithOwner: "example/project",
        pullRequest: { ...metadata, reviews: { nodes, pageInfo: pagination } },
      },
    },
  };
}

describe("authored feedback source", () => {
  test("finds all ages and drafts, includes bots, and filters self, unsubmitted, dismissed and empty approvals", async () => {
    const requests: z.infer<typeof RequestSchema>[] = [];
    const source = createGithubFeedbackSource({
      execute: async (args, input) => {
        assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
        const request = RequestSchema.parse(JSON.parse(input!));
        requests.push(request);
        if (request.query.includes("AuthoredFeedback")) return JSON.stringify(discoveryResponse());
        return JSON.stringify(
          reviewsResponse([
            review,
            { ...review, id: "R_bot", author: { login: "robot[bot]" } },
            { ...review, id: "R_self", author: { login: "OWNER" } },
            { ...review, id: "R_pending", state: "PENDING" },
            { ...review, id: "R_dismissed", state: "DISMISSED" },
            { ...review, id: "R_unsubmitted", submittedAt: null },
            { ...review, id: "R_empty", state: "APPROVED", body: "  " },
            { ...review, id: "R_inline", state: "APPROVED", body: "", comments: { totalCount: 1 } },
          ]),
        );
      },
    });
    const result = await source.discover();
    assert.equal(result.author, "owner");
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(
      result.candidates[0]!.reviews.map((item) => item.id),
      ["R_bot", "R_inline", "R_one"],
    );
    assert.equal(result.candidates[0]!.reviews[0]!.author, "robot[bot]");
    assert.equal(result.rateLimit.cost, 2);
    assert.match(
      requests[0]!.query,
      /pullRequests\(first: 100, after: \$after, states: \[OPEN\]\)/,
    );
    assert.doesNotMatch(requests[0]!.query, /search\(|created:|updated:|draft:false/);
    assert.deepEqual(requests[0]!.variables, { after: null });
    assert.equal(requests.length, 2);
  });

  test("paginates authored PRs and reviews without dropping eligible reviews", async () => {
    let discoveryPages = 0;
    let reviewPages = 0;
    const source = createGithubFeedbackSource({
      execute: async (_args, input) => {
        const request = RequestSchema.parse(JSON.parse(input!));
        if (request.query.includes("AuthoredFeedback")) {
          discoveryPages++;
          if (!request.variables.after)
            return JSON.stringify(
              discoveryResponse([], { hasNextPage: true, endCursor: "pull-next" }),
            );
          assert.equal(request.variables.after, "pull-next");
          return JSON.stringify(discoveryResponse());
        }
        reviewPages++;
        if (!request.variables.after)
          return JSON.stringify(
            reviewsResponse([review], { hasNextPage: true, endCursor: "review-next" }),
          );
        assert.equal(request.variables.after, "review-next");
        return JSON.stringify(reviewsResponse([{ ...review, id: "R_two" }]));
      },
    });
    const result = await source.discover();
    assert.equal(discoveryPages, 2);
    assert.equal(reviewPages, 2);
    assert.equal(result.candidates[0]!.reviews.length, 2);
    assert.equal(result.rateLimit.cost, 4);
  });

  test("paginates more than 1,000 authored PRs without a search limit", async () => {
    const pulls = Array.from({ length: 1001 }, (_, index) => ({
      ...pull,
      number: index + 1,
      url: `https://github.com/example/project/pull/${index + 1}`,
    }));
    let discoveryPages = 0;
    const source = createGithubFeedbackSource({
      execute: async (_args, input) => {
        const request = RequestSchema.parse(JSON.parse(input!));
        if (request.query.includes("AuthoredFeedback")) {
          discoveryPages++;
          assert.equal(request.variables.query, undefined);
          const offset = Number(request.variables.after ?? 0);
          const next = offset + 100;
          return JSON.stringify(
            discoveryResponse(pulls.slice(offset, next), {
              hasNextPage: next < pulls.length,
              endCursor: next < pulls.length ? String(next) : null,
            }),
          );
        }
        const metadata = pulls[Number(request.variables.number) - 1]!;
        return JSON.stringify(
          reviewsResponse(
            [
              {
                ...review,
                id: `R_${metadata.number}`,
                url: `${metadata.url}#pullrequestreview-${metadata.number}`,
              },
            ],
            pageInfo,
            metadata,
          ),
        );
      },
    });
    const result = await source.discover();
    assert.equal(discoveryPages, 11);
    assert.deepEqual(
      result.candidates.map((item) => item.number),
      pulls.map((item) => item.number),
    );
    assert.equal(result.rateLimit.cost, 1012);
  });

  test("rejects repeated discovery cursors and account changes between pages", async () => {
    const repeated = createGithubFeedbackSource({
      execute: async () =>
        JSON.stringify(discoveryResponse([], { hasNextPage: true, endCursor: "same" })),
    });
    await assert.rejects(repeated.discover(), /invalid pagination/);
    let pages = 0;
    const changed = createGithubFeedbackSource({
      execute: async () => {
        const response = discoveryResponse([], { hasNextPage: true, endCursor: "next" });
        if (pages++) response.data.viewer.login = "another";
        return JSON.stringify(response);
      },
    });
    await assert.rejects(changed.discover(), /author changed/);
  });

  test("comments without submitted reviews do not create candidates", async () => {
    const source = createGithubFeedbackSource({
      execute: async (_args, input) => {
        const request = RequestSchema.parse(JSON.parse(input!));
        return JSON.stringify(
          request.query.includes("AuthoredFeedback") ? discoveryResponse() : reviewsResponse([]),
        );
      },
    });
    assert.deepEqual((await source.discover()).candidates, []);
  });

  test("revalidates closure, ownership, head commit, fork and branch before admission", async () => {
    for (const metadata of [
      { ...pull, state: "CLOSED" },
      { ...pull, author: { login: "another" } },
      { ...pull, headRefOid: "b".repeat(40) },
      { ...pull, headRepository: { nameWithOwner: "another/project" } },
      { ...pull, headRefName: "another-branch" },
    ]) {
      const source = createGithubFeedbackSource({
        execute: async () => JSON.stringify(reviewsResponse([review], pageInfo, metadata)),
      });
      assert.ok((await source.inspect(candidate, "owner")).blockedReason);
    }
  });

  test("rejects changed authentication, conflicting review IDs and invalid pagination", async () => {
    const changedIdentity = reviewsResponse();
    changedIdentity.data.viewer.login = "another";
    const source = createGithubFeedbackSource({
      execute: async () => JSON.stringify(changedIdentity),
    });
    await assert.rejects(source.inspect(candidate, "owner"), /author changed/);
    const conflicting = createGithubFeedbackSource({
      execute: async () =>
        JSON.stringify(reviewsResponse([review, { ...review, body: "Changed" }])),
    });
    await assert.rejects(conflicting.inspect(candidate, "owner"), /conflicting review IDs/);
    const broken = createGithubFeedbackSource({
      execute: async () =>
        JSON.stringify(reviewsResponse([review], { hasNextPage: true, endCursor: null })),
    });
    await assert.rejects(broken.inspect(candidate, "owner"), /invalid pagination/);
  });

  test("revalidates each review page and retains accumulated cost when the head changes", async () => {
    let pages = 0;
    const source = createGithubFeedbackSource({
      execute: async () => {
        pages++;
        return JSON.stringify(
          pages === 1
            ? reviewsResponse([review], { hasNextPage: true, endCursor: "next" })
            : reviewsResponse([], pageInfo, { ...pull, headRefOid: "b".repeat(40) }),
        );
      },
    });
    const result = await source.inspect(candidate, "owner");
    assert.equal(pages, 2);
    assert.equal(result.blockedReason, "head-changed");
    assert.deepEqual(result.candidate, candidate);
    assert.equal(result.rateLimit.cost, 2);
  });

  test("rejects account changes between review pages", async () => {
    let pages = 0;
    const source = createGithubFeedbackSource({
      execute: async () => {
        const response = reviewsResponse([review], { hasNextPage: true, endCursor: "next" });
        if (pages++) response.data.viewer.login = "another";
        return JSON.stringify(response);
      },
    });
    await assert.rejects(source.inspect(candidate, "owner"), /author changed/);
    assert.equal(pages, 2);
  });

  test("rejects partial API data and preserves rate-limit guidance without private errors", async () => {
    const source = createGithubFeedbackSource({
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      execute: async () =>
        JSON.stringify({
          ...discoveryResponse(),
          errors: [{ type: "RATE_LIMITED", message: "private upstream details" }],
        }),
    });
    await assert.rejects(source.discover(), (err: unknown) => {
      assert.ok(err instanceof GithubReviewSourceError);
      assert.equal(err.retryAfterMs, 86_400_000);
      assert.doesNotMatch(err.message, /private upstream details/);
      return true;
    });
  });

  test("cancels before invoking the GitHub transport", async () => {
    let called = false;
    const source = createGithubFeedbackSource({
      execute: async () => {
        called = true;
        return "";
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(source.discover(controller.signal));
    assert.equal(called, false);
  });
});
