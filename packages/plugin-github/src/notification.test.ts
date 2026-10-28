import { describe, expect, test } from "vitest";
import { createFakePluginContext } from "@picco-agent/core/testing";
import { notifications } from "../../plugin-notifications/src/index.js";
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

  test.each([
    "membership transport",
    "membership response",
    "membership payload",
    "token before GET",
    "token before PATCH",
  ])("recovers keyed progress after %s fails before a write", async (failure) => {
    let failing = false;
    let tokenCalls = 0;
    const calls: { method: string; body: RequestInit["body"] }[] = [];
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: () => {
        if (failing) {
          tokenCalls++;
          if (
            (failure === "token before GET" && tokenCalls === 1) ||
            (failure === "token before PATCH" && tokenCalls === 2)
          )
            throw new Error("Private credential lookup failure");
        }
        return "test-token";
      },
      fetch: async (_url, init) => {
        calls.push({ method: init!.method!, body: init?.body });
        if (failing && init?.method === "GET") {
          if (failure === "membership transport") throw new Error("Private transport failure");
          if (failure === "membership response") return new Response(null, { status: 503 });
          if (failure === "membership payload") return Response.json({ id: 77 });
        }
        return Response.json(comment());
      },
    });
    const notifier = notifications({ destinations: { github: adapter } });
    await notifier.start?.(createFakePluginContext());
    const progress = { scope: "review-one", messageKey: "progress" };
    try {
      expect(
        (await notifier.notify({ ...progress, text: "Starting" })).deliveries[0],
      ).toMatchObject({ status: "confirmed", externalId: "77" });
      failing = true;
      expect(
        (await notifier.notify({ ...progress, text: "Checking" })).deliveries[0],
      ).toMatchObject({ status: "rejected", externalId: "77" });
      expect(calls.some(({ method }) => method === "PATCH")).toBe(false);
      failing = false;
      expect(
        (await notifier.notify({ ...progress, text: "Finished" })).deliveries[0],
      ).toMatchObject({ status: "confirmed", externalId: "77" });
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
      expect(calls.filter(({ method }) => method === "PATCH")).toEqual([
        { method: "PATCH", body: JSON.stringify({ body: "Finished" }) },
      ]);
    } finally {
      await notifier.stop?.();
    }
  });

  test("recovers an initial keyed send after token acquisition fails before fetch", async () => {
    let tokenAvailable = false;
    let writes = 0;
    const adapter = githubNotifications({
      repository: "owner/project",
      pullRequest: 42,
      token: () => {
        if (!tokenAvailable) throw new Error("Private credential lookup failure");
        return "test-token";
      },
      fetch: async () => {
        writes++;
        return Response.json(comment());
      },
    });
    const notifier = notifications({ destinations: { github: adapter } });
    await notifier.start?.(createFakePluginContext());
    try {
      const progress = { scope: "review-one", messageKey: "progress" };
      expect((await notifier.notify({ ...progress, text: "Starting" })).deliveries[0].status).toBe(
        "rejected",
      );
      expect(writes).toBe(0);
      tokenAvailable = true;
      expect((await notifier.notify({ ...progress, text: "Ready" })).deliveries[0]).toMatchObject({
        status: "confirmed",
        externalId: "77",
      });
      expect(writes).toBe(1);
    } finally {
      await notifier.stop?.();
    }
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

  test("keeps uncertainty when an edit may already have reached GitHub", async () => {
    for (const transport of [
      async () => {
        throw new Error("Private transport failure");
      },
      async () => new Response(null, { status: 503 }),
      async () => Response.json({ id: 77 }),
    ]) {
      const adapter = githubNotifications({
        repository: "owner/project",
        pullRequest: 42,
        token: "test-token",
        fetch: async (_url, init) =>
          init?.method === "GET" ? Response.json(comment()) : transport(),
      });
      await expect(adapter.update!("77", "Finished", new AbortController().signal)).rejects.toThrow(
        /GitHub notification (transport failed|outcome is uncertain|response could not be confirmed)/,
      );
    }
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
