import * as z from "zod";
import { describe, expect, test } from "vitest";
import { silentLogger, type Plugin, type ToolContext } from "@picco-agent/core";
import { githubTools } from "./tools.js";

/**
 * Use the real public tools and their input validation with a cancellable bridge context.
 */
async function invoke(
  plugin: Plugin,
  name: string,
  input: unknown,
  signal = new AbortController().signal,
): Promise<unknown> {
  const selected = plugin.tools!.find((entry) => entry.name === name)!;
  const ctx: ToolContext = { caller: { kind: "host" }, logger: silentLogger(), signal };
  return JSON.parse(String(await selected.execute(selected.input.parse(input), ctx)));
}

/**
 * Minimal successful provider resources for each GitHub operation.
 */
const target = { repository: "owner/project", pullRequest: 42, body: "    Review progress" };
const comment = { id: 77, issue_url: "https://api.github.com/repos/owner/project/issues/42" };
const diffComment = {
  id: 88,
  pull_request_url: "https://api.github.com/repos/owner/project/pulls/42",
};
const head = "a".repeat(40);

describe("GitHub PR tools", () => {
  test("creates and edits one conversation comment with host credentials and cancellation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const plugin = githubTools({
      token: () => "test-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(comment);
      },
    });
    const signal = new AbortController().signal;
    expect(plugin.name).toBe("github-tools");
    expect(plugin.start).toBeUndefined();
    expect(plugin.tools!.map(({ name }) => name)).toEqual([
      "github_comment",
      "github_inline_comment",
      "github_review",
    ]);
    expect(await invoke(plugin, "github_comment", target, signal)).toEqual({
      status: "confirmed",
      commentId: "77",
    });
    expect(
      await invoke(
        plugin,
        "github_comment",
        { ...target, commentId: "77", body: "Finished" },
        signal,
      ),
    ).toEqual({ status: "confirmed", commentId: "77" });
    expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
      ["https://api.github.com/repos/owner/project/issues/42/comments", "POST"],
      ["https://api.github.com/repos/owner/project/issues/comments/77", "GET"],
      ["https://api.github.com/repos/owner/project/issues/comments/77", "PATCH"],
    ]);
    expect(calls.every(({ init }) => init?.signal === signal)).toBe(true);
    expect(calls[0].init?.headers).toMatchObject({
      authorization: "Bearer test-token",
      "x-github-api-version": "2026-03-10",
    });
    expect(calls[2].init?.body).toBe(JSON.stringify({ body: "Finished" }));
  });

  test("rejects an edit for another PR before sending PATCH", async () => {
    const methods: string[] = [];
    const plugin = githubTools({
      token: "test-token",
      fetch: async (_url, init) => {
        methods.push(init!.method!);
        return Response.json({ ...comment, issue_url: comment.issue_url.replace("42", "99") });
      },
    });
    expect(await invoke(plugin, "github_comment", { ...target, commentId: "77" })).toMatchObject({
      status: "rejected",
    });
    expect(methods).toEqual(["GET"]);
  });

  test("resolves the current head only when inline commitId is omitted and maps multiline locations", async () => {
    const calls: { method?: string; body?: RequestInit["body"] }[] = [];
    const plugin = githubTools({
      token: "test-token",
      fetch: async (_url, init) => {
        calls.push({ method: init?.method, body: init?.body });
        return Response.json(init?.method === "GET" ? { head: { sha: head } } : diffComment);
      },
    });
    const inline = {
      ...target,
      path: "src/file.ts",
      line: 9,
      side: "RIGHT",
      startLine: 7,
      startSide: "RIGHT",
    };
    expect(await invoke(plugin, "github_inline_comment", inline)).toEqual({
      status: "confirmed",
      commentId: "88",
    });
    await invoke(plugin, "github_inline_comment", { ...inline, commitId: head });
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "POST"]);
    expect(JSON.parse(String(calls[1].body))).toEqual({
      body: target.body,
      path: "src/file.ts",
      line: 9,
      side: "RIGHT",
      start_line: 7,
      start_side: "RIGHT",
      commit_id: head,
    });
  });

  test.each([
    { action: "comment", event: "COMMENT", state: "COMMENTED" },
    { action: "approve", event: "APPROVE", state: "APPROVED" },
    { action: "request_changes", event: "REQUEST_CHANGES", state: "CHANGES_REQUESTED" },
  ])(
    "submits $action immediately with optional inline findings",
    async ({ action, event, state }) => {
      const bodies: unknown[] = [];
      const plugin = githubTools({
        token: "test-token",
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ...diffComment, state });
        },
      });
      expect(
        await invoke(plugin, "github_review", {
          ...target,
          body: action === "approve" ? undefined : target.body,
          action,
          commitId: head,
          comments: [{ body: "Finding", path: "src/file.ts", line: 3 }],
        }),
      ).toEqual({ status: "confirmed", reviewId: "88", state });
      expect(bodies).toEqual([
        {
          ...(action === "approve" ? {} : { body: target.body }),
          event,
          commit_id: head,
          comments: [{ body: "Finding", path: "src/file.ts", line: 3, side: "RIGHT" }],
        },
      ]);
    },
  );

  test("validates model arguments, excludes credentials and checks same-side ranges", () => {
    const plugin = githubTools({ token: "test-token" });
    const ordinary = plugin.tools![0];
    const inline = plugin.tools![1];
    const review = plugin.tools![2];
    for (const input of [
      { ...target, repository: "../repo" },
      { ...target, pullRequest: 0 },
      { ...target, body: " " },
      { ...target, body: "x".repeat(65_537) },
      { ...target, token: "model-token" },
      { ...target, commentId: "../77" },
    ])
      expect(ordinary.input.safeParse(input).success).toBe(false);
    const location = { ...target, path: "a.ts", line: 5, side: "RIGHT" };
    expect(inline.input.safeParse({ ...location, startLine: 7, startSide: "RIGHT" }).success).toBe(
      false,
    );
    expect(inline.input.safeParse({ ...location, startLine: 7, startSide: "LEFT" }).success).toBe(
      true,
    );
    expect(inline.input.safeParse({ ...location, startLine: 2 }).success).toBe(false);
    expect(
      review.input.safeParse({ repository: "owner/project", pullRequest: 42, action: "approve" })
        .success,
    ).toBe(true);
    for (const action of ["comment", "request_changes"])
      expect(
        review.input.safeParse({ repository: "owner/project", pullRequest: 42, action }).success,
      ).toBe(false);
    expect(
      review.input.safeParse({
        ...target,
        action: "approve",
        comments: Array.from({ length: 101 }, () => ({ body: "x", path: "a", line: 1 })),
      }).success,
    ).toBe(false);
    for (const selected of plugin.tools!)
      expect(z.toJSONSchema(selected.input, { io: "input" })).toMatchObject({ type: "object" });
  });

  test("an unexpected review state is unconfirmed even when GitHub returns success", async () => {
    const plugin = githubTools({
      token: "test-token",
      fetch: async () => Response.json({ ...diffComment, state: "COMMENTED" }),
    });
    expect(await invoke(plugin, "github_review", { ...target, action: "approve" })).toMatchObject({
      status: "uncertain",
    });
  });

  test("credential and failed membership lookup paths remain rejected with no write", async () => {
    let credentialAvailable = false;
    let calls = 0;
    const plugin = githubTools({
      token: () => {
        if (!credentialAvailable) throw new Error("private-token");
        return "test-token";
      },
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
    });
    expect(await invoke(plugin, "github_comment", target)).toMatchObject({ status: "rejected" });
    expect(calls).toBe(0);
    credentialAvailable = true;
    expect(await invoke(plugin, "github_comment", { ...target, commentId: "77" })).toMatchObject({
      status: "rejected",
    });
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(await invoke(plugin, "github_comment", target, controller.signal)).toMatchObject({
      status: "rejected",
    });
    expect(calls).toBe(1);
  });

  test.each(["transport", "server", "malformed"])(
    "keeps an ambiguous %s write uncertain without retrying",
    async (failure) => {
      let calls = 0;
      const plugin = githubTools({
        token: "test-token",
        fetch: async () => {
          calls++;
          if (failure === "transport") throw new Error("private-token");
          return failure === "server"
            ? new Response(null, { status: 503 })
            : Response.json({ id: 77 });
        },
      });
      expect(await invoke(plugin, "github_comment", target)).toEqual({
        status: "uncertain",
        message: "GitHub may have accepted the write. Inspect GitHub before retrying.",
      });
      expect(calls).toBe(1);
    },
  );
});
