import { createAppAuth } from "@octokit/auth-app";
import * as z from "zod";

/**
 * Minimal socket surface the plugin uses. `ws`'s WebSocket satisfies this.
 */
export interface SocketLike {
  on(event: "open", fn: () => void): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "close", fn: () => void): void;
  on(event: "error", fn: (err: unknown) => void): void;
  close(): void;
}

/**
 * Normalised event payload forwarded by the local-agent-relay. The relay has already verified the
 * signature, filtered by event type and action, and dropped self-mentions — this schema validates
 * the shape we receive.
 */
export const RelayEventSchema = z.object({
  source: z.literal("github"),
  eventType: z.string(),
  payload: z
    .object({
      repo: z.string(),
      prNumber: z.number().optional(),
      issueNumber: z.number().optional(),
      comment: z.string().default(""),
      commentId: z.number().optional(),
      author: z.string().optional(),
      /**
       * The commenter's numeric GitHub id (payload sender.id) — stable across renames, unlike
       * `author`. Basis of the turn's SessionIdentity.
       */
      authorId: z.number().optional(),
      action: z.string().optional(),
      installationId: z.number().optional(),
    })
    .refine((p) => p.prNumber != null || p.issueNumber != null, "no pr/issue number"),
});

/**
 * One validated relay event, derived from the schema.
 */
export type RelayEvent = z.infer<typeof RelayEventSchema>;

/**
 * Create an installation-token minter backed by @octokit/auth-app.
 */
export function createTokenMinter(
  appId: string,
  privateKey: string,
): (installationId: number) => Promise<string> {
  const auth = createAppAuth({ appId, privateKey });
  return async (installationId: number) => {
    const { token } = await auth({ type: "installation", installationId });
    return token;
  };
}
