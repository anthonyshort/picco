import * as z from "zod";
import type { NotificationAdapter } from "@picco-agent/plugin-notifications";

/**
 * GitHub's issue-comment body limit, before transport.
 */
const MAX_BODY_LENGTH = 65_536;

/**
 * Host-supplied repository and PR determine the only writable conversation.
 */
const TargetSchema = z.object({
  repository: z
    .string()
    .max(200)
    .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
    .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."))
    .transform((value) => value.toLowerCase()),
  pullRequest: z.number().int().positive().safe(),
});

/**
 * Comment IDs remain decimal strings across notification storage and transports.
 */
const CommentIdSchema = z
  .string()
  .max(32)
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

/**
 * Select receipt fields only; GitHub's response contains unrelated private data.
 */
const CommentSchema = z.object({ id: z.number().int().positive().safe(), issue_url: z.url() });

/**
 * One fixed PR recipient, independent of the GitHub mention gateway.
 */
export type GithubNotificationOptions = z.input<typeof TargetSchema> & {
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
};

/**
 * Send GitHub Markdown comments and update only comments belonging to the configured PR.
 */
export function githubNotifications(options: GithubNotificationOptions): NotificationAdapter {
  const { repository, pullRequest } = TargetSchema.parse(options);
  const issueUrl = `https://api.github.com/repos/${repository}/issues/${pullRequest}`;
  const commentsUrl = `https://api.github.com/repos/${repository}/issues/comments`;
  const request = options.fetch ?? fetch;

  async function call(url: string, method: string, signal: AbortSignal, text?: string) {
    let token: string;
    try {
      token = (typeof options.token === "function" ? await options.token() : options.token).trim();
    } catch {
      return undefined;
    }
    if (!token) return undefined;
    let response: Response;
    try {
      response = await request(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2026-03-10",
        },
        body: text === undefined ? undefined : JSON.stringify({ body: text }),
        redirect: "error",
        signal,
      });
    } catch {
      if (method === "GET") return undefined;
      throw new Error("GitHub notification transport failed");
    }
    if (response.status >= 500 || response.status === 408) {
      if (method === "GET") return undefined;
      throw new Error("GitHub notification outcome is uncertain");
    }
    if (!response.ok) return undefined;
    try {
      return CommentSchema.parse(await response.json());
    } catch {
      if (method === "GET") return undefined;
      throw new Error("GitHub notification response could not be confirmed");
    }
  }

  function belongsToTarget(comment: z.infer<typeof CommentSchema>) {
    return comment.issue_url.toLowerCase() === issueUrl;
  }

  return {
    targetId: `github:${repository}:pull:${pullRequest}`,
    async send(text, signal) {
      if (!validText(text)) return { status: "rejected" };
      const comment = await call(`${issueUrl}/comments`, "POST", signal, text);
      if (!comment) return { status: "rejected" };
      if (!belongsToTarget(comment))
        throw new Error("GitHub notification target could not be confirmed");
      return { status: "confirmed", externalId: String(comment.id) };
    },
    async update(externalId, text, signal) {
      if (!CommentIdSchema.safeParse(externalId).success || !validText(text))
        return { status: "rejected" };
      const url = `${commentsUrl}/${externalId}`;
      const previous = await call(url, "GET", signal);
      if (!previous || !belongsToTarget(previous) || String(previous.id) !== externalId)
        return { status: "rejected" };
      const updated = await call(url, "PATCH", signal, text);
      if (!updated) return { status: "rejected" };
      if (!belongsToTarget(updated) || String(updated.id) !== externalId)
        throw new Error("GitHub notification update could not be confirmed");
      return { status: "confirmed", externalId };
    },
  };
}

/**
 * Keep Markdown intact; GitHub renders the platform format.
 */
function validText(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_BODY_LENGTH;
}
