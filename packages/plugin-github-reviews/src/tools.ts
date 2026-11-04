import { tool } from "@picco-agent/core";
import { z } from "zod";
import { ReviewStartSchema } from "./review-types.js";
import type { Reviews } from "./reviews.js";

/**
 * Define agent and external entry points for the same reviews service.
 */
export function createReviewTools(ensureReviews: () => Reviews, source: "tool" | "mcp") {
  const empty = z.object({}).strict();
  const identity = z.object({ id: z.uuid() }).strict();
  return [
    tool({
      name: "github_reviews_start",
      description:
        "Queue a local-only review for a repository and PR number. Reuse requestId for the same submission; returns a job ID, not a completed report.",
      input: ReviewStartSchema,
      async execute(input) {
        return JSON.stringify(await ensureReviews().submit(input, source));
      },
    }),
    tool({
      name: "github_reviews_status",
      description:
        "Inspect review polling, runtime pause and active workers without starting work.",
      input: empty,
      execute() {
        return JSON.stringify(ensureReviews().status());
      },
    }),
    tool({
      name: "github_reviews_list",
      description: "List accepted review jobs and their saved status.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
      execute({ limit }) {
        return JSON.stringify(ensureReviews().list(limit));
      },
    }),
    tool({
      name: "github_reviews_details",
      description: "Inspect a saved review job and its previous attempts.",
      input: identity,
      execute({ id }) {
        return JSON.stringify(ensureReviews().details(id));
      },
    }),
    tool({
      name: "github_reviews_report",
      description: "Read the latest saved review result and its complete or partial outcome.",
      input: identity,
      execute({ id }) {
        return JSON.stringify(ensureReviews().report(id));
      },
    }),
    tool({
      name: "github_reviews_cancel",
      description:
        "Cancel queued or active review work and await worker cleanup. Does not remove saved reports.",
      input: identity,
      async execute({ id }) {
        return JSON.stringify(await ensureReviews().cancel(id));
      },
    }),
    tool({
      name: "github_reviews_retry",
      description:
        "Queue a fresh attempt of a stopped unsuccessful review. Completed jobs require a new submission.",
      input: identity,
      execute({ id }) {
        return JSON.stringify(ensureReviews().retry(id));
      },
    }),
    tool({
      name: "github_reviews_poll",
      description:
        "Discover current GitHub review requests subject to configured enablement and API backoff.",
      input: empty,
      async execute() {
        await ensureReviews().poll();
        return JSON.stringify(ensureReviews().status());
      },
    }),
    tool({
      name: "github_reviews_pause",
      description:
        "Pause new review execution until resumed or the host restarts. Active workers continue.",
      input: empty,
      execute() {
        return JSON.stringify(ensureReviews().pause(true));
      },
    }),
    tool({
      name: "github_reviews_resume",
      description: "Resume new review execution in this host process.",
      input: empty,
      execute() {
        return JSON.stringify(ensureReviews().pause(false));
      },
    }),
  ];
}
