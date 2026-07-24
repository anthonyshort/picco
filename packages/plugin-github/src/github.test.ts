import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "@picco-agent/core";
import { createFakePluginContext, type FakePluginContextOptions } from "@picco-agent/core/testing";
import { buildGithubPrompt, github, githubSessionKey, type GithubOptions } from "./index.js";

describe("githubSessionKey", () => {
  test("derives raw local keys (no platform prefix — the framework namespaces)", () => {
    expect(githubSessionKey("owner/repo", "pr", 7, "abc12345")).toBe("owner-repo-pr-7-abc12345");
    expect(githubSessionKey("owner/repo", "issue", 42, "def67890")).toBe(
      "owner-repo-issue-42-def67890",
    );
  });

  test("distinguishes pr from issue and mention from mention", () => {
    expect(githubSessionKey("a/b", "pr", 5, "x")).not.toBe(
      githubSessionKey("a/b", "issue", 5, "x"),
    );
    expect(githubSessionKey("a/b", "pr", 5, "one")).not.toBe(
      githubSessionKey("a/b", "pr", 5, "two"),
    );
  });
});

describe("buildGithubPrompt", () => {
  test("includes repo, number, author, and comment for a PR", () => {
    const prompt = buildGithubPrompt({
      author: "human",
      repo: "owner/repo",
      prNumber: 7,
      comment: "@agent-bot[bot] please review",
    });
    expect(prompt).toContain("PR");
    expect(prompt).toContain("owner/repo#7");
    expect(prompt).toContain("human");
    expect(prompt).toContain("@agent-bot[bot] please review");
  });

  test("includes repo and number for an issue, and handles empty comments", () => {
    expect(
      buildGithubPrompt({ author: "human", repo: "owner/repo", issueNumber: 42, comment: "x" }),
    ).toContain("owner/repo#42");
    expect(buildGithubPrompt({ repo: "a/b", issueNumber: 1, comment: "" })).toContain("(empty)");
  });
});

/**
 * A minimal fake WebSocket for connection tests.
 */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    closed: false,
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, fn);
    },
    close() {
      this.closed = true;
      handlers.get("close")?.();
    },
    fire(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
  };
}

async function setup(over: Partial<GithubOptions> = {}, ctxOpts: FakePluginContextOptions = {}) {
  const socket = fakeSocket();
  const ctx = createFakePluginContext({ source: "github", ...ctxOpts });
  const plugin = github({
    relayUrl: "ws://relay",
    botUsername: "agent-bot[bot]",
    appId: "1",
    privateKey: "pem",
    mintToken: async () => "installation-token-123",
    createSocket: () => socket,
    // The final-message fallback posts after every turn — keep tests offline.
    postComment: async () => {},
    ...over,
  });
  await plugin.start!(ctx);
  return { plugin, ctx, socket };
}

const mention = (payload: Record<string, unknown>) => ({
  source: "github",
  eventType: "issue_comment",
  payload,
});

describe("github plugin", () => {
  test("starts and stops cleanly", async () => {
    const { plugin, socket } = await setup();
    expect(socket.closed).toBe(false);
    await plugin.stop!();
    expect(socket.closed).toBe(true);
  });

  test("drops malformed events and events without repo/number", async () => {
    const { plugin, ctx } = await setup();

    await plugin.handleEvent("not-json");
    await plugin.handleEvent({ source: "stripe", eventType: "x", payload: {} });
    await plugin.handleEvent(mention({ comment: "hi", author: "human" }));
    await plugin.handleEvent(mention({ repo: "o/r", comment: "hi", author: "human" }));

    expect(ctx.turns).toHaveLength(0);
  });

  test("mints a token, sets env, runs the turn", async () => {
    const { plugin, ctx } = await setup();

    await plugin.handleEvent(
      mention({
        repo: "owner/repo",
        issueNumber: 42,
        comment: "@agent-bot[bot] review please",
        author: "human",
        installationId: 99,
      }),
    );

    expect(ctx.turns).toHaveLength(1);
    const { key, prompt } = ctx.turns[0]!;
    expect(key).toMatch(/^owner-repo-issue-42-[a-f0-9]{8}$/);
    expect(prompt).toContain("owner/repo#42");

    expect(ctx.sessions.get(key!)).toBeDefined();
  });

  test("passes GH_TOKEN as per-session env via ctx.sessions.open", async () => {
    const opened: Array<{ key: string; env?: Record<string, string> }> = [];
    const ctx = createFakePluginContext({ source: "github" });
    const realOpen = ctx.sessions.open.bind(ctx.sessions);
    ctx.sessions.open = async (key, opts) => {
      opened.push({ key, env: opts?.env });
      return realOpen(key, opts);
    };
    const plugin = github({
      relayUrl: "ws://relay",
      botUsername: "agent-bot[bot]",
      appId: "1",
      privateKey: "pem",
      mintToken: async () => "tok-env",
      createSocket: () => fakeSocket(),
      postComment: async () => {},
    });
    await plugin.start!(ctx);

    await plugin.handleEvent(
      mention({ repo: "o/r", prNumber: 5, comment: "go", author: "human", installationId: 7 }),
    );

    expect(opened).toHaveLength(1);
    // GH_TOKEN plus the bot's git identity — commits must not fall back to
    // the host user's gitconfig.
    expect(opened[0]!.env).toEqual({
      GH_TOKEN: "tok-env",
      GIT_AUTHOR_NAME: "agent-bot[bot]",
      GIT_AUTHOR_EMAIL: "agent-bot[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "agent-bot[bot]",
      GIT_COMMITTER_EMAIL: "agent-bot[bot]@users.noreply.github.com",
    });
  });

  test("attaches the mentioning user's stable id as the turn's SessionIdentity", async () => {
    const { plugin, ctx } = await setup();

    await plugin.handleEvent(
      mention({
        repo: "o/r",
        issueNumber: 1,
        comment: "@agent-bot[bot] hi",
        author: "anthonyshort",
        authorId: 12345,
        installationId: 99,
      }),
    );
    await plugin.handleEvent(
      mention({ repo: "o/r", issueNumber: 2, comment: "hi", installationId: 99 }),
    );

    expect(ctx.turns[0]!.user).toEqual({
      source: "github",
      id: "12345",
      display: "anthonyshort",
    });
    // No numeric sender id → unattributed turn, never a handle-keyed one.
    expect(ctx.turns[1]!.user).toBeUndefined();
  });

  test("proceeds without a token when installationId is absent", async () => {
    const { plugin, ctx } = await setup();

    await plugin.handleEvent(
      mention({ repo: "owner/repo", issueNumber: 1, comment: "hi", author: "human" }),
    );

    expect(ctx.turns).toHaveLength(1);
    // The prompt must not let the system append's "gh is authenticated" claim stand.
    expect(ctx.turns[0]!.prompt).toContain("no bot GitHub credentials");
    // No token → no post_comment tool either (it needs the token in its closure).
    expect(ctx.sessionTools).toHaveLength(0);
  });

  test("binds a per-mention post_comment tool with the token in its closure", async () => {
    const posted: Array<{ repo: string; number: number; body: string; token: string }> = [];
    const { plugin, ctx } = await setup(
      {
        postComment: async (args) => {
          posted.push(args);
        },
      },
      // An empty final message keeps the fallback quiet — only the manual
      // tool execution below should post.
      { reply: () => "" },
    );

    await plugin.handleEvent(
      mention({
        repo: "owner/repo",
        issueNumber: 42,
        comment: "@agent-bot[bot] review please",
        author: "human",
        installationId: 99,
      }),
    );

    expect(ctx.sessionTools).toHaveLength(1);
    const { key, tools } = ctx.sessionTools[0]!;
    expect(key).toBe(ctx.turns[0]!.key);
    expect(tools.map((t) => t.name)).toEqual(["post_comment"]);
    expect(tools[0]!.description).toContain("owner/repo#42");

    // Execute host-side, as the bridge would: repo, number, and the token
    // come from the closure — the model only supplies the body.
    const result = await tools[0]!.execute(
      { body: "hello from the bot" },
      { logger: silentLogger(), caller: { kind: "session", ref: { source: "github", key: key! } } },
    );
    expect(result).toBe("posted");
    expect(posted).toEqual([
      {
        repo: "owner/repo",
        number: 42,
        body: "hello from the bot",
        token: "installation-token-123",
      },
    ]);
  });

  test("posts the final message as the comment when the model never calls post_comment", async () => {
    const posted: Array<{ repo: string; number: number; body: string; token: string }> = [];
    const { plugin } = await setup(
      {
        postComment: async (args) => {
          posted.push(args);
        },
      },
      { reply: () => "Here is my analysis of the issue." },
    );

    await plugin.handleEvent(
      mention({
        repo: "owner/repo",
        issueNumber: 42,
        comment: "go",
        author: "h",
        installationId: 9,
      }),
    );

    expect(posted).toEqual([
      {
        repo: "owner/repo",
        number: 42,
        body: "Here is my analysis of the issue.",
        token: "installation-token-123",
      },
    ]);
  });

  test("skips the fallback when the model already replied via post_comment", async () => {
    const posted: Array<{ body: string }> = [];
    let ctx!: ReturnType<typeof createFakePluginContext>;
    const result = await setup(
      {
        postComment: async (args) => {
          posted.push({ body: args.body });
        },
      },
      {
        // The scripted model calls the bound post_comment tool mid-turn,
        // then still writes a final message.
        reply: async () => {
          const { key, tools } = ctx.sessionTools[0]!;
          await tools[0]!.execute(
            { body: "replied via the tool" },
            {
              logger: silentLogger(),
              caller: { kind: "session", ref: { source: "github", key: key! } },
            },
          );
          return "final message that must NOT be posted";
        },
      },
    );
    ctx = result.ctx;

    await result.plugin.handleEvent(
      mention({ repo: "o/r", issueNumber: 1, comment: "go", author: "h", installationId: 9 }),
    );

    expect(posted).toEqual([{ body: "replied via the tool" }]);
  });

  test("does not fallback-post an empty final message", async () => {
    const posted: unknown[] = [];
    const { plugin } = await setup(
      {
        postComment: async (args) => {
          posted.push(args);
        },
      },
      { reply: () => "  \n" },
    );

    await plugin.handleEvent(
      mention({ repo: "o/r", issueNumber: 1, comment: "go", author: "h", installationId: 9 }),
    );

    expect(posted).toEqual([]);
  });

  test("proceeds without gh auth when minting fails", async () => {
    const { plugin, ctx } = await setup({
      mintToken: async () => {
        throw new Error("mint failed");
      },
    });

    await plugin.handleEvent(
      mention({ repo: "o/r", issueNumber: 1, comment: "hi", author: "human", installationId: 9 }),
    );

    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0]!.prompt).toContain("no bot GitHub credentials");
  });

  test("a failed turn is contained (logged, not thrown)", async () => {
    const { plugin, ctx } = await setup(
      {},
      {
        reply: () => {
          throw new Error("turn exploded");
        },
      },
    );

    await expect(
      plugin.handleEvent(mention({ repo: "o/r", issueNumber: 1, comment: "hi", author: "human" })),
    ).resolves.toBeUndefined();
    expect(ctx.turns).toHaveLength(1);
  });

  test("reconnects with exponential backoff after the socket closes", async () => {
    vi.useFakeTimers();
    try {
      const sockets: ReturnType<typeof fakeSocket>[] = [];
      const ctx = createFakePluginContext({ source: "github" });
      const plugin = github({
        relayUrl: "ws://relay",
        botUsername: "b",
        appId: "1",
        privateKey: "pem",
        mintToken: async () => "t",
        createSocket: () => {
          const s = fakeSocket();
          sockets.push(s);
          return s;
        },
      });
      await plugin.start!(ctx);
      expect(sockets).toHaveLength(1);

      sockets[0]!.fire("close");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);

      sockets[1]!.fire("close");
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(3);

      // open resets the delay
      sockets[2]!.fire("open");
      sockets[2]!.fire("close");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(4);

      await plugin.stop!();
    } finally {
      vi.useRealTimers();
    }
  });
});
