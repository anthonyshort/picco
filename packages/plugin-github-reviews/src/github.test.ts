import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createGithubSource,
  GithubReviewSourceError,
  type Candidate,
  type GithubExecute,
} from "./github.js";

/**
 * Fixed source clock for age and request-time tests.
 */
const NOW = Date.parse("2026-10-26T12:00:00Z");
/**
 * Commit identity shared by source fixtures.
 */
const HEAD = "a".repeat(40);
/**
 * Creation time within the configured review window.
 */
const CREATED = "2026-10-25T12:00:00Z";
/**
 * Latest personal request fixture time.
 */
const REQUESTED = "2026-10-26T10:00:00Z";
/**
 * Canonical requested pull request used by inspection tests.
 */
const candidate: Candidate = {
  repository: "owner/one",
  number: 12,
  title: "Requested change",
  url: "https://github.com/owner/one/pull/12",
  head: HEAD,
  createdAt: CREATED,
};

describe("GitHub review source", () => {
  test("discovers configured repositories in one paginated GraphQL search without starting a model", async () => {
    const calls: string[][] = [];
    const inputs: string[] = [];
    const source = createGithubSource({
      now: () => NOW,
      execute: async (args, input) => {
        calls.push(args);
        inputs.push(input ?? "");
        return JSON.stringify(
          discovery([pull(candidate)], {
            repository1: { nameWithOwner: "owner/two", pullRequests: { totalCount: 1 } },
          }),
        );
      },
    });
    const result = await source.discover(["owner/one", "owner/two"], 28);
    expect(calls).toEqual([["api", "graphql", "--input", "-"]]);
    expect(inputs[0]).toContain("repo:owner/one OR repo:owner/two");
    expect(inputs[0]).toContain("type: ISSUE_ADVANCED");
    expect(inputs[0]).toContain("created:>=2026-09-28");
    expect(result).toEqual({
      reviewer: "reviewer",
      candidates: [candidate],
      rateLimit: { cost: 1, remaining: 4_999, resetAt: "2026-10-26T13:00:00Z" },
    });
  });

  test("sorts candidates globally and accumulates paginated query cost", async () => {
    let page = 0;
    const older = {
      ...candidate,
      number: 13,
      url: "https://github.com/owner/one/pull/13",
      createdAt: "2026-10-24T12:00:00Z",
    };
    const source = createGithubSource({
      now: () => NOW,
      execute: async (args, input) => {
        expect(args).toEqual(["api", "graphql", "--input", "-"]);
        if (page++ === 0)
          return JSON.stringify(
            discovery([pull(candidate)], {}, { hasNextPage: true, endCursor: "page-two" }),
          );
        expect(input).toContain('"after":"page-two"');
        return JSON.stringify(discovery([pull(older)]));
      },
    });
    const result = await source.discover(["owner/one"], 28);
    expect(result.candidates).toEqual([older, candidate]);
    expect(result.rateLimit.cost).toBe(2);
  });

  test("enforces exact age boundary, state and draft checks locally", async () => {
    const atCutoff = { ...candidate, createdAt: "2026-09-28T12:00:00Z" };
    const beforeCutoff = {
      ...candidate,
      number: 13,
      url: "https://github.com/owner/one/pull/13",
      createdAt: "2026-09-28T11:59:59Z",
    };
    const source = createGithubSource({
      now: () => NOW,
      execute: async () =>
        JSON.stringify(
          discovery([
            pull(atCutoff),
            pull(beforeCutoff),
            {
              ...pull(candidate),
              number: 14,
              url: "https://github.com/owner/one/pull/14",
              isDraft: true,
            },
            {
              ...pull(candidate),
              number: 15,
              url: "https://github.com/owner/one/pull/15",
              state: "CLOSED",
            },
          ]),
        ),
    });
    expect((await source.discover(["owner/one"], 28)).candidates).toEqual([atCutoff]);
  });

  test("fails closed on GraphQL errors despite usable partial data", async () => {
    const source = createGithubSource({
      now: () => NOW,
      execute: async () =>
        JSON.stringify({ ...discovery([]), errors: [{ message: "permission denied" }] }),
    });
    await expect(source.discover(["owner/one"], 28)).rejects.toThrow("incomplete");
  });

  test("exposes safe rate-limit retry guidance without forwarding private error messages", async () => {
    const source = createGithubSource({
      now: () => NOW,
      execute: async () =>
        JSON.stringify({
          ...discovery([]),
          errors: [{ type: "RATE_LIMITED", message: "private payload" }],
        }),
    });
    await expect(source.discover(["owner/one"], 28)).rejects.toMatchObject({
      name: "GithubReviewSourceError",
      retryAfterMs: 3_600_000,
    });
    try {
      await source.discover(["owner/one"], 28);
    } catch (err) {
      expect(err).toBeInstanceOf(GithubReviewSourceError);
      expect(String(err)).not.toContain("private payload");
    }
  });

  test("does not treat an inaccessible repository as an empty queue", async () => {
    const source = createGithubSource({
      now: () => NOW,
      execute: async () => JSON.stringify(discovery([], { repository0: null })),
    });
    await expect(source.discover(["owner/one"], 28)).rejects.toThrow("inaccessible");
  });

  test("rejects capped results and cursor loops rather than returning incomplete candidates", async () => {
    const capped = createGithubSource({
      now: () => NOW,
      execute: async () => JSON.stringify(discovery([], {}, undefined, 1_001)),
    });
    await expect(capped.discover(["owner/one"], 28)).rejects.toThrow("1,000-result");
    const repeated = createGithubSource({
      now: () => NOW,
      execute: async () =>
        JSON.stringify(discovery([], {}, { hasNextPage: true, endCursor: "same" })),
    });
    await expect(repeated.discover(["owner/one"], 28)).rejects.toThrow("pagination");
  });

  test("rejects foreign URLs and unconfigured repositories", async () => {
    const source = createGithubSource({
      now: () => NOW,
      execute: async () =>
        JSON.stringify(
          discovery([{ ...pull(candidate), url: "https://github.com/other/one/pull/12" }]),
        ),
    });
    await expect(source.discover(["owner/one"], 28)).rejects.toThrow("URL");
    const foreign = {
      ...candidate,
      repository: "owner/foreign",
      url: "https://github.com/owner/foreign/pull/12",
    };
    const other = createGithubSource({
      now: () => NOW,
      execute: async () => JSON.stringify(discovery([pull(foreign)])),
    });
    await expect(other.discover(["owner/one"], 28)).rejects.toThrow("unconfigured");
  });

  test("accepts canonical GitHub repository URL casing while preserving exact PR identity", async () => {
    const capitalised = {
      ...candidate,
      repository: "Owner/One",
      url: "https://github.com/Owner/One/pull/12",
    };
    const source = createGithubSource({
      now: () => NOW,
      execute: async () => JSON.stringify(discovery([pull(capitalised)])),
    });
    const found = await source.discover(["Owner/One"], 28);
    expect(found.candidates).toEqual([{ ...capitalised, repository: "owner/one" }]);
    const fixture = inspectionFixture({
      selected: found.candidates[0],
      live: { url: "https://github.com/owner/ONE/pull/12" },
    });
    expect(
      (await fixture.source.inspect(found.candidates[0], "reviewer")).blockedReason,
    ).toBeUndefined();
    for (const url of [
      "https://github.com/Owner/One/pull/12?secret=value",
      "https://github.com/Owner/One/pull/12#comment",
      "https://github.com/Owner/One/pull/13",
      "https://example.com/Owner/One/pull/12",
    ]) {
      await expect(
        fixture.source.inspect({ ...found.candidates[0], url }, "reviewer"),
      ).rejects.toThrow("URL");
    }
  });

  test("propagates cancellation before querying GitHub", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = createGithubSource({
      execute: async () => {
        throw new Error("transport should not run");
      },
    });
    await expect(source.discover(["owner/one"], 28, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("inspects request cycles with opaque GraphQL event identity", async () => {
    const fixture = inspectionFixture({
      events: [request(71, REQUESTED, "someone-else"), request(70, REQUESTED)],
    });
    const result = await fixture.source.inspect(candidate, "Reviewer");
    expect(result).toMatchObject({ candidate, requestEventId: "event:70", requestedAt: REQUESTED });
    expect(result.rateLimit).toEqual({
      cost: 1,
      remaining: 4_999,
      resetAt: "2026-10-26T13:00:00Z",
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls.every((args) => !args.includes("--method"))).toBe(true);
  });

  test("rechecks live readiness, head and direct reviewer before detailed evidence reads", async () => {
    for (const [live, reason] of [
      [{ state: "CLOSED" }, "no-longer-ready-for-review"],
      [{ isDraft: true }, "no-longer-ready-for-review"],
      [{ headRefOid: "b".repeat(40) }, "head-changed"],
      [
        { reviewRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        "review-no-longer-requested",
      ],
    ] as const) {
      const fixture = inspectionFixture({ live });
      expect((await fixture.source.inspect(candidate, "reviewer")).blockedReason).toBe(reason);
      expect(fixture.calls).toHaveLength(1);
    }
  });

  test("normal inspection uses database-owned completion history without review or comment scans", async () => {
    const fixture = inspectionFixture({ events: [request()] });
    const result = await fixture.source.inspect(candidate, "reviewer");
    expect(result.blockedReason).toBeUndefined();
    expect(fixture.calls.some((args) => /\/(reviews|comments)\?/.test(args[1]))).toBe(false);
  });

  test("paginates current requests independently from request history", async () => {
    const fixture = inspectionFixture({
      requests: [{ requestedReviewer: {} }],
      secondRequestPage: [{ requestedReviewer: { login: "reviewer" } }],
      events: [request()],
    });
    const result = await fixture.source.inspect(candidate, "reviewer");
    expect(result.blockedReason).toBeUndefined();
    expect(result.requestEventId).toBe("event:70");
    expect(result.rateLimit.cost).toBe(2);
    expect(fixture.inputs[1]).toContain('"after":"more-requests"');
    expect(fixture.inputs[1]).toContain('"includeTimeline":false');
  });

  test("continues history with the completed request connection omitted", async () => {
    const fixture = inspectionFixture({ events: [], secondEventPage: [request()] });
    const result = await fixture.source.inspect(candidate, "reviewer");
    expect(result).toMatchObject({
      requestEventId: "event:70",
      requestedAt: REQUESTED,
      rateLimit: { cost: 2 },
    });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.inputs[1]).toContain('"includeRequests":false');
    expect(fixture.inputs[1]).toContain('"before":"older"');
  });

  test("rechecks live eligibility after either inspection connection finishes", async () => {
    for (const historyFirst of [true, false]) {
      for (const [change, reason] of [
        [{ headRefOid: "b".repeat(40) }, "head-changed"],
        [{ isDraft: true }, "no-longer-ready-for-review"],
        [{ state: "CLOSED" }, "no-longer-ready-for-review"],
      ] as const) {
        const fixture = inspectionFixture({
          ...(historyFirst
            ? {
                events: [request()],
                requests: [],
                secondRequestPage: [{ requestedReviewer: { login: "reviewer" } }],
              }
            : { events: [], secondEventPage: [request()] }),
          live: (page) => (page === 2 ? change : {}),
        });
        const result = await fixture.source.inspect(candidate, "reviewer");
        expect(result.blockedReason).toBe(reason);
        expect(result.rateLimit.cost).toBe(2);
        expect(result.requestEventId).toBe(historyFirst ? "event:70" : undefined);
        expect(fixture.calls).toHaveLength(2);
      }
    }
  });

  test("rechecks viewer and pull request identity while only history remains", async () => {
    const viewer = inspectionFixture({
      secondEventPage: [request()],
      viewer: (page) => (page === 2 ? "another-reviewer" : "reviewer"),
    });
    await expect(viewer.source.inspect(candidate, "reviewer")).rejects.toThrow("reviewer changed");
    const identity = inspectionFixture({
      secondEventPage: [request()],
      live: (page) => (page === 2 ? { number: 13 } : {}),
    });
    await expect(identity.source.inspect(candidate, "reviewer")).rejects.toThrow(
      "identity does not match",
    );
  });

  test("blocks a missing personal request before processing invalid history", async () => {
    const fixture = inspectionFixture({
      requests: [],
      events: [request(70, "2026-10-27T10:00:00Z")],
    });
    expect((await fixture.source.inspect(candidate, "reviewer")).blockedReason).toBe(
      "review-no-longer-requested",
    );
  });

  test("a team request does not count as a direct personal request", async () => {
    const fixture = inspectionFixture({ requests: [{ requestedReviewer: {} }] });
    expect((await fixture.source.inspect(candidate, "reviewer")).blockedReason).toBe(
      "review-no-longer-requested",
    );
  });

  test("selects the newest targeted event without converting opaque identifiers", async () => {
    const fixture = inspectionFixture({
      events: [request(70, "2026-10-26T09:00:00Z"), request(71)],
    });
    const result = await fixture.source.inspect(candidate, "reviewer");
    expect(result.requestEventId).toBe("event:71");
    expect(result.requestedAt).toBe(REQUESTED);
  });

  test("a reviewer identity change blocks inspection", async () => {
    const fixture = inspectionFixture();
    await expect(fixture.source.inspect(candidate, "another-reviewer")).rejects.toThrow(
      "reviewer changed",
    );
  });

  test("partial inspection errors never admit candidates", async () => {
    const source = createGithubSource({
      execute: async () => JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED" }] }),
    });
    await expect(source.inspect(candidate, "reviewer")).rejects.toMatchObject({
      name: "GithubReviewSourceError",
      retryAfterMs: 60_000,
    });
  });

  test("rejects repeated cursors in either inspection connection", async () => {
    const requests = inspectionFixture({
      live: { reviewRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } },
    });
    await expect(requests.source.inspect(candidate, "reviewer")).rejects.toThrow(
      "invalid pagination",
    );
    const timeline = inspectionFixture({
      live: {
        timelineItems: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: "same" } },
      },
    });
    await expect(timeline.source.inspect(candidate, "reviewer")).rejects.toThrow(
      "invalid pagination",
    );
  });

  test("missing event history remains inspectable without inventing a request cycle", async () => {
    const result = await inspectionFixture().source.inspect(candidate, "reviewer");
    expect(result.requestEventId).toBeUndefined();
    expect(result.requestedAt).toBeUndefined();
  });

  test("rejects future and conflicting request events", async () => {
    for (const events of [
      [request(70, "2026-10-27T10:00:00Z")],
      [request(70, REQUESTED), request(70, "2026-10-26T09:00:00Z")],
      [{ event: "review_requested", id: 70, created_at: REQUESTED }],
    ]) {
      await expect(
        inspectionFixture({ events }).source.inspect(candidate, "reviewer"),
      ).rejects.toThrow();
    }
  });

  test("paginates request history backwards until the latest personal request is found", async () => {
    const fixture = inspectionFixture({
      events: Array.from({ length: 100 }, (_, index) =>
        request(index + 1_000, REQUESTED, "someone-else"),
      ),
      secondEventPage: [request()],
    });
    expect((await fixture.source.inspect(candidate, "reviewer")).requestEventId).toBe("event:70");
    expect(fixture.calls).toHaveLength(2);
    expect((await fixture.source.inspect(candidate, "reviewer")).rateLimit.cost).toBe(2);
    expect(fixture.inputs[1]).toContain('"before":"older"');
  });
});

/**
 * Build a complete GraphQL response with repository access evidence.
 */
function discovery(
  nodes: unknown[],
  extra: Record<string, unknown> = {},
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
  issueCount = nodes.length,
) {
  return {
    data: {
      viewer: { login: "reviewer" },
      repository0: { nameWithOwner: "owner/one", pullRequests: { totalCount: 1 } },
      ...extra,
      search: { issueCount, nodes, pageInfo },
      rateLimit: { cost: 1, remaining: 4_999, resetAt: "2026-10-26T13:00:00Z" },
    },
  };
}

/**
 * Convert a canonical candidate into GraphQL wire fields.
 */
function pull(selected: Candidate) {
  return {
    number: selected.number,
    title: selected.title,
    url: selected.url,
    headRefOid: selected.head,
    createdAt: selected.createdAt,
    isDraft: false,
    state: "OPEN",
    repository: { nameWithOwner: selected.repository },
  };
}

/**
 * Build opaque GraphQL request-event evidence.
 */
function request(id = 70, created_at = REQUESTED, reviewer = "reviewer") {
  return { id: `event:${id}`, createdAt: created_at, requestedReviewer: { login: reviewer } };
}

/**
 * Provide a strict transport that rejects unexpected endpoints.
 */
function inspectionFixture(
  opts: {
    events?: unknown[];
    live?: Record<string, unknown> | ((page: number) => Record<string, unknown>);
    viewer?: (page: number) => string;
    secondEventPage?: unknown[];
    requests?: unknown[];
    secondRequestPage?: unknown[];
    selected?: Candidate;
  } = {},
) {
  const calls: string[][] = [];
  const inputs: string[] = [];
  const selected = opts.selected ?? candidate;
  const execute: GithubExecute = async (args, input) => {
    calls.push(args);
    inputs.push(input ?? "");
    expect(args).toEqual(["api", "graphql", "--input", "-"]);
    expect(input).toContain("query InspectReview");
    const { variables } = z
      .object({
        variables: z.object({
          after: z.string().nullable(),
          before: z.string().nullable(),
          includeRequests: z.boolean(),
          includeTimeline: z.boolean(),
        }),
      })
      .parse(JSON.parse(input ?? ""));
    const olderPage = variables.before === "older";
    const nextRequests = variables.after === "more-requests";
    const live = {
      number: selected.number,
      title: selected.title,
      url: selected.url,
      createdAt: selected.createdAt,
      headRefOid: HEAD,
      state: "OPEN",
      isDraft: false,
      reviewRequests: {
        nodes: nextRequests
          ? (opts.secondRequestPage ?? [])
          : (opts.requests ?? [
              { requestedReviewer: { login: opts.viewer?.(calls.length) ?? "reviewer" } },
            ]),
        pageInfo: {
          hasNextPage: Boolean(opts.secondRequestPage) && !nextRequests,
          endCursor: "more-requests",
        },
      },
      timelineItems: {
        nodes: olderPage ? (opts.secondEventPage ?? []) : (opts.events ?? []),
        pageInfo: {
          hasPreviousPage: Boolean(opts.secondEventPage) && !olderPage,
          startCursor: "older",
        },
      },
      ...(typeof opts.live === "function" ? opts.live(calls.length) : opts.live),
    };
    return JSON.stringify({
      data: {
        viewer: { login: opts.viewer?.(calls.length) ?? "reviewer" },
        repository: {
          nameWithOwner: selected.repository,
          pullRequest: {
            ...live,
            reviewRequests: variables.includeRequests ? live.reviewRequests : undefined,
            timelineItems: variables.includeTimeline ? live.timelineItems : undefined,
          },
        },
        rateLimit: { cost: 1, remaining: 4_999, resetAt: "2026-10-26T13:00:00Z" },
      },
    });
  };
  return { source: createGithubSource({ execute, now: () => NOW }), calls, inputs };
}
