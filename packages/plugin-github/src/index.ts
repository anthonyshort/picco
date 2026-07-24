/**
 * `@picco-agent/plugin-github` — GitHub @mention gateway plugin.
 *
 * Relay WebSocket with exponential reconnect, fresh session per mention (raw local keys — the
 * framework namespaces them), installation-token minting, per-session GH_TOKEN env, long turn
 * timeout. Failed turns are auto-reset by the framework.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import * as z from "zod";
import { tool, type Tool } from "@picco-agent/core";
import type { Plugin, PluginContext, SessionIdentity } from "@picco-agent/core";
import { createTokenMinter, RelayEventSchema, type RelayEvent, type SocketLike } from "./relay.js";

const DEFAULT_TURN_TIMEOUT_MS = 1_800_000; // 30 minutes — reviews clone + read

/**
 * Function that posts a comment on a GitHub PR or issue. Injected for tests; the default
 * implementation hits the GitHub REST API.
 */
export type PostComment = (args: {
  repo: string;
  number: number;
  body: string;
  token: string;
}) => Promise<void>;

/**
 * Configuration for the GitHub @mention gateway plugin. Requires a relay URL, bot username, and app
 * credentials for token minting.
 */
export interface GithubOptions {
  relayUrl: string;
  botUsername: string;
  appId: string;
  privateKey: string;
  /**
   * Override the default system prompt append.
   */
  systemAppend?: string;
  /**
   * Per-turn timeout. Default: 30 minutes.
   */
  turnTimeoutMs?: number;
  /**
   * Mints an installation access token. Injected for tests.
   */
  mintToken?: (installationId: number) => Promise<string>;
  /**
   * Posts the comment behind the session-scoped post_comment tool. Injected for tests; default hits
   * the GitHub REST API.
   */
  postComment?: PostComment;
  /**
   * Override the WebSocket constructor (tests).
   */
  createSocket?: (url: string) => SocketLike;
}

/**
 * GitHub plugin interface with an exposed handleEvent method for testing. Extends the base Plugin
 * interface with event handling capabilities.
 */
export interface GithubPlugin extends Plugin {
  /**
   * Handle a single relay event — exposed for testing.
   */
  handleEvent(raw: unknown): Promise<void>;
}

/**
 * Derive a per-mention session key for a PR or issue thread. Each @mention gets a fresh session
 * (unique suffix) so the agent starts clean every time rather than continuing an old thread. Raw
 * local key — no platform prefix; the framework namespaces it under the plugin.
 */
export function githubSessionKey(
  repo: string,
  kind: "pr" | "issue",
  number: number,
  uniqueId: string,
): string {
  const safeRepo = repo.replace("/", "-");
  return `${safeRepo}-${kind}-${number}-${uniqueId}`;
}

/**
 * Default GitHub session rules appended to the Pi system prompt.
 */
export function defaultSystemAppend(botUsername: string): string {
  return `
## GitHub session rules
You are responding to a @mention on GitHub, posting as @${botUsername}.
- \`gh\` is already authenticated as the bot via the GH_TOKEN env var.
  Do NOT run \`gh auth login\` or override GH_TOKEN.
- Read context with \`gh issue view <N> --repo <repo> --json title,body,comments\`
  (or \`gh pr view\`, \`gh pr diff\` for PRs).
- Reply in-thread with the \`post_comment\` tool — it posts to this thread as
  the bot. If you finish without calling it, your final message is posted
  as the reply instead. (\`gh pr review <N> --repo <repo> --comment --body
  "..."\` still works when you need a formal PR review comment.)
- Reference files with backticks. Keep replies focused on the specific feedback.
- If asked to make changes: clone via
  \`git clone https://x-access-token:${"${GH_TOKEN}"}@github.com/<repo>.git\`,
  branch, commit, push, and post a summary comment.
- The GH_TOKEN is short-lived (1h) and scoped to this installation.`;
}

/**
 * Build the prompt handed to the agent for a mention.
 */
export function buildGithubPrompt(event: {
  author?: string;
  repo: string;
  prNumber?: number;
  issueNumber?: number;
  comment: string;
}): string {
  const kind = event.prNumber != null ? "PR" : "issue";
  const number = event.prNumber ?? event.issueNumber;
  const author = event.author ?? "someone";
  return [
    `You were @mentioned by ${author} in a ${kind} comment on ${event.repo}#${number}.`,
    "",
    "Their comment:",
    event.comment || "(empty)",
  ].join("\n");
}

/**
 * Git identity for the session's commits. Without this, git falls back to GIT_CONFIG_GLOBAL — the
 * host user's .gitconfig — and bot commits get attributed to the operator. These env vars outrank
 * every config file.
 */
export function gitIdentityEnv(botUsername: string): Record<string, string> {
  const email = `${botUsername}@users.noreply.github.com`;
  return {
    GIT_AUTHOR_NAME: botUsername,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: botUsername,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * The commenter as a kernel SessionIdentity: stable numeric id, display for logs only.
 */
export function githubIdentity(
  authorId: number | undefined,
  author?: string,
): SessionIdentity | undefined {
  if (authorId == null) return undefined;
  return { source: "github", id: String(authorId), display: author };
}

/**
 * PR comments are issue comments — one endpoint covers both.
 */
const defaultPostComment: PostComment = async ({ repo, number, body, token }) => {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "agent",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub comment failed: ${res.status} ${detail}`.trim());
  }
};

/**
 * Session-scoped comment tool: repo, number, and the installation token live in the host-side
 * closure, so commenting never exposes the token to the session. (Clone/push flows still need
 * GH_TOKEN in the session env — git runs inside; the closure route shrinks the token's exposure,
 * not to zero.)
 */
function buildPostCommentTool(
  repo: string,
  number: number,
  ghToken: string,
  postComment: PostComment,
): Tool {
  return tool({
    name: "post_comment",
    description: `Post a comment on ${repo}#${number} as the bot. Use this to reply in-thread.`,
    input: z.object({ body: z.string().min(1) }),
    async execute({ body }) {
      await postComment({ repo, number, body, token: ghToken });
      return "posted";
    },
  });
}

/**
 * Create the GitHub plugin: relay listener, per-mention sessions, bot auth.
 */
export function github(options: GithubOptions): GithubPlugin {
  const systemAppend = options.systemAppend ?? defaultSystemAppend(options.botUsername);
  const mintToken = options.mintToken ?? createTokenMinter(options.appId, options.privateKey);
  const postComment = options.postComment ?? defaultPostComment;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

  let ctx: PluginContext | null = null;
  let socket: SocketLike | undefined;
  let reconnectDelay = 1000;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Open the relay socket and wire reconnect-on-close.
   */
  function connect(): void {
    if (stopped || !ctx) return;
    ctx.logger.log("connecting to relay", { url: options.relayUrl });
    socket = options.createSocket
      ? options.createSocket(options.relayUrl)
      : new WebSocket(options.relayUrl);

    socket.on("open", () => {
      reconnectDelay = 1000;
      ctx?.logger.log("connected to relay");
    });

    socket.on("message", (data: unknown) => {
      void handleEvent(typeof data === "string" ? data : String(data));
    });

    socket.on("close", () => {
      ctx?.logger.log("relay connection closed");
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      ctx?.logger.error("relay socket error", err);
      // close handler will trigger reconnect
    });
  }

  /**
   * Reconnect after the current backoff delay, doubling it up to 30s.
   */
  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      connect();
    }, reconnectDelay);
  }

  /**
   * Validate one relay event and run a fresh-session turn for the mention. The relay owns event
   * filtering (signatures, event types, self-mentions); the schema enforces the shape, including
   * repo + a pr/issue number.
   */
  async function handleEvent(raw: unknown): Promise<void> {
    if (!ctx) throw new Error("github plugin is not started");
    let parsed: RelayEvent;
    try {
      const json = typeof raw === "string" ? JSON.parse(raw) : raw;
      parsed = RelayEventSchema.parse(json);
    } catch (err) {
      ctx.logger.error("dropping malformed relay event", err);
      return;
    }

    const { payload } = parsed;
    const isPr = payload.prNumber != null;
    const number = payload.prNumber ?? payload.issueNumber!;
    // Fresh session per mention — unique suffix avoids continuing an old thread.
    const key = githubSessionKey(
      payload.repo,
      isPr ? "pr" : "issue",
      number,
      randomUUID().slice(0, 8),
    );
    ctx.logger.log("mention received", { key, repo: payload.repo, number });

    // Mint an installation token so the agent can post as the bot via gh.
    let ghToken: string | undefined;
    if (payload.installationId != null) {
      try {
        ghToken = await mintToken(payload.installationId);
      } catch (err) {
        ctx.logger.error("failed to mint installation token", err);
      }
    } else {
      ctx.logger.log("no installationId on event — agent will lack gh auth", {
        eventType: parsed.eventType,
        repo: payload.repo,
      });
    }

    const basePrompt = buildGithubPrompt({
      author: payload.author,
      repo: payload.repo,
      prNumber: payload.prNumber,
      issueNumber: payload.issueNumber,
      comment: payload.comment,
    });
    // The system append claims gh auth; without a token that would be a lie the model
    // flails against — say so instead.
    const prompt = ghToken
      ? basePrompt
      : `${basePrompt}\n\n(Note: no bot GitHub credentials are available for this mention — gh is not authenticated and post_comment is unavailable.)`;

    try {
      // Track whether the model actually delivered a reply through the tool,
      // so an undelivered final message can be posted as the fallback below.
      let replied = false;
      const recordingPostComment: PostComment = async (args) => {
        await postComment(args);
        replied = true;
      };

      // open() first: the token file must land in the session cwd, and the
      // GH_TOKEN env var must be present at session spawn.
      const session = await ctx.sessions.open(key, {
        pi: { instructions: systemAppend },
        env: ghToken ? { GH_TOKEN: ghToken, ...gitIdentityEnv(options.botUsername) } : undefined,
        tools: ghToken
          ? [buildPostCommentTool(payload.repo, number, ghToken, recordingPostComment)]
          : undefined,
      });
      // A failed turn (timeout, crash) is reset by the framework — the next
      // mention gets a fresh session either way (fresh keys per mention).
      // The mentioning user rides the turn (per-user connections); GitHub
      // has no private channel, so this gateway surfaces no /connect
      // commands — users connect via a DM-capable gateway.
      const { text } = await session.run(prompt, {
        timeoutMs: turnTimeoutMs,
        user: githubIdentity(payload.authorId, payload.author),
      });
      // The final message goes nowhere by itself. If the model wrote its
      // reply there instead of calling post_comment, post it for them.
      if (ghToken && !replied && text.trim()) {
        await postComment({ repo: payload.repo, number, body: text, token: ghToken });
        ctx.logger.log("posted final message as comment", { key });
      }
      ctx.logger.log("handled mention", { key });
    } catch (err) {
      ctx.logger.error("mention handler failed", { key, error: err });
    }
  }

  return {
    name: "github",

    async start(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      stopped = false;
      connect();
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      ctx?.logger.log("stopped");
    },

    handleEvent,
  };
}
