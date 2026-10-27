import { describe, expect, test } from "vitest";
import { githubNotifications } from "./notification.js";

/**
 * Minimal GitHub receipt for the configured PR.
 */
function comment(issue = 42) {
  return { id: 77, issue_url: `https://api.github.com/repos/owner/project/issues/${issue}` };
}

describe("GitHub notification adapter", () => {
  test("sends Markdown to its configured PR with a renewable token and cancellation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let tokenCalls = 0;
    const adapter = githubNotifications({
      repository: "Owner/Project",
      pullRequest: 42,
      token: async () => {
        tokenCalls++;
        return "test-token";
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(comment(), { status: 201 });
      },
    });
    const signal = new AbortController().signal;
    expect(adapter.targetId).toBe("github:owner/project:pull:42");
    expect(await adapter.send("- [x] Context\n- [ ] Review", signal)).toEqual({
      status: "confirmed",
      externalId: "77",
    });
    expect(tokenCalls).toBe(1);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/owner/project/issues/42/comments",
        init: {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "x-github-api-version": "2026-03-10",
          },
          body: JSON.stringify({ body: "- [x] Context\n- [ ] Review" }),
          redirect: "error",
          signal,
        },
      },
    ]);
  });

  test("checks comment membership before editing and preserves its external ID", async () => {
    const calls: { url: string; method?: string; body?: RequestInit["body"] }[] = [];
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: "test-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body });
        return Response.json(comment());
      },
    });
    expect(await adapter.update!("77", "Finished", new AbortController().signal)).toEqual({
      status: "confirmed",
      externalId: "77",
    });
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/owner/project/issues/comments/77",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.github.com/repos/owner/project/issues/comments/77",
        method: "PATCH",
        body: JSON.stringify({ body: "Finished" }),
      },
    ]);
  });

  test("rejects other PRs, malformed IDs and oversized bodies before a write", async () => {
    const methods: string[] = [];
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: "test-token",
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json(comment(99));
      },
    });
    const signal = new AbortController().signal;
    expect(await adapter.update!("77", "Wrong PR", signal)).toEqual({ status: "rejected" });
    for (const id of ["../77", "0", "77?next=99", "9007199254740992"])
      expect(await adapter.update!(id, "Wrong ID", signal)).toEqual({ status: "rejected" });
    expect(await adapter.send(" ", signal)).toEqual({ status: "rejected" });
    expect(await adapter.send("x".repeat(65_537), signal)).toEqual({ status: "rejected" });
    expect(methods).toEqual(["GET"]);
    for (const repository of ["../project", "owner/..", "owner/project/extra"])
      expect(() =>
        githubNotifications({ repository, pullRequest: 42, token: "test-token" }),
      ).toThrow();
    expect(() =>
      githubNotifications({ repository: "owner/project", pullRequest: 0, token: "test-token" }),
    ).toThrow();
  });

  test.each([403, 404, 422, 429])("treats HTTP %s as definite rejection", async (status) => {
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: "test-token",
      fetch: async () => Response.json({ message: "private diagnostic" }, { status }),
    });
    expect(await adapter.send("Ready", new AbortController().signal)).toEqual({
      status: "rejected",
    });
  });

  test.each([408, 500, 503])("does not claim rejection after ambiguous HTTP %s", async (status) => {
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: "test-token",
      fetch: async () => Response.json({ message: "private diagnostic" }, { status }),
    });
    await expect(adapter.send("Ready", new AbortController().signal)).rejects.toThrow(
      "outcome is uncertain",
    );
  });

  test("malformed successful receipts and lost responses remain uncertain without exposing credentials", async () => {
    for (const transport of [
      async () => Response.json({ id: 77 }, { status: 201 }),
      async () => {
        throw new Error("test-token: private network diagnostic");
      },
    ]) {
      const adapter = githubNotifications({
        repository: "owner/project",
        pullRequest: 42,
        token: "test-token",
        fetch: transport,
      });
      await expect(adapter.send("Ready", new AbortController().signal)).rejects.toThrow(
        /GitHub notification (response could not be confirmed|transport failed)/,
      );
    }
  });
});
