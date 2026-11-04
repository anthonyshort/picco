# Run GitHub reviews

The GitHub reviews plugin discovers personal review requests and runs accepted jobs through one queue and worker limit. SQLite retains jobs, attempts and full reports; discovery and worker ownership stay in memory. Run one host per review data directory. Polling is the automatic trigger; the reviews service owns accepted work and execution.

To address reviews on your own PRs, use the separate [feedback workflow](./github-feedback.md).

## Configure the plugin

Register the plugin using the usual Pi model, installed review skills and sandbox configuration:

```ts
import { githubReviews } from "@picco-agent/plugin-github-reviews";
import { z } from "zod";

const Report = z.object({ markdown: z.string() });
const reviews = githubReviews({
  enabled: true,
  repositories: [{ name: "example/widgets", skill: "review" }],
  maxConcurrentReviews: 2,
  resultSchema: Report,
});
```

Put `reviews` in the agent's `plugins` array. Authentication uses the host's GitHub CLI by default. The plugin polls on startup, validates personal review requests and checks the PR again before each execution. A new commit does not trigger another automatic review unless a newer review request exists. Genuine failures and manual cancellations stay stopped until an explicit retry or a newer request. Known GitHub retry deadlines leave accepted work queued and delay further GitHub admission reads until the deadline; polling and queued execution resume automatically.

`enabled: false` disables automatic polling and execution of queued polling jobs. Removing a repository route also stops its queued automatic work. Runtime pause, poll timing and backoff reset after restart; permanent disablement belongs in configuration.

## Finish a selected review

The selected worker receives `github_review_finish`. Its arguments contain the final outcome and JSON-encoded report in one submission:

```json
{
  "status": "completed",
  "summary": "No required changes.",
  "result": "{\"markdown\":\"No required changes.\"}"
}
```

Reports are bounded to 4 MiB; diagnostic output is a separate bounded preview. With `resultSchema`, a completed review must supply a non-null report accepted by that schema. The host saves the parsed report together with completion. Without a schema, generic JSON or summary-only completion is allowed. Failed outcomes can retain partial JSON without applying the completed-report schema. Only the selected review session may call this tool. A launch receipt or final prose does not complete a review. For unsuccessful work, use `status: "failed"`, its actual `error`, and an optional partial `result`. `github_review_complete` remains a compatibility adapter for successful submissions through the same path; it accepts `summary` and optional `result`. Both worker tools belong to the selected review session.

The application can supply `prompt(selection)` for its saved workflow and report format. Finish and verify required GitHub publication before declaring success. Picco does not independently verify that write. Recorded completion remains complete if later worker cleanup fails, with cleanup failure reported separately.

Use `onRunStart` and `onRunComplete` for application notifications on published reviews. Callback failure is logged and does not repeat execution or change a saved successful outcome. Callbacks are bounded to 30 seconds. Cancellation or the review deadline also ends the start-callback wait; worker startup receives only the time remaining in the original review budget. Notification delivery is best effort, without a persistent delivery/reconciliation protocol.

## Run a saved Pi workflow

Install pi-subagents and the saved workflow into the worker's Pi profile. Set `holdWorkflows: true` and supply a prompt that launches `SubagentWorkflow`, yields, waits for its completion notification, verifies its result and calls `github_review_finish`. The initial task ID acknowledges launch only. The host retains the review execution and concurrency slot through the background workflow and parent follow-up, under its original deadline. Failed or stopped workflows fail execution.

## Inspect, cancel and retry

`github_reviews_status` reports this process's poll health, API budget, pause state and active workers. `github_reviews_list` lists accepted jobs, rather than every discovered candidate. `github_reviews_pause` stops new execution while active work finishes; `github_reviews_resume` resumes it. Pause ends when the host restarts. `github_reviews_poll` requests discovery subject to enablement and API backoff.

`github_reviews_cancel` stops queued work or waits for active worker teardown. `github_reviews_retry` queues a fresh attempt of an unsuccessful job and retains earlier results. Retry while queued or active does not enqueue another attempt. A delayed duplicate retry after its attempt finishes can start another run; there is no per-command receipt protocol. A completed automatic job requires a newer review request.

On crash or normal shutdown, unfinished attempts become interrupted and restart as new sessions at the current PR revisions. Completed, genuinely failed and manually cancelled jobs stay stopped. There is no workflow resumption, persistent dispatcher lease, publication claim or operator attestation. Do not run overlapping hosts against one directory.

Publication remains application policy. Best-effort reuse of the authenticated author's comment on the same PR and full commit can reduce duplicates after restart. GitHub publication and SQLite completion are separate operations, so this does not guarantee exactly-once comments.

The exported `GithubReviewsOptions` type is the configuration reference. See [Plugins](./plugins.md) for lifecycle and [Sessions](../concepts/sessions.md) for worker ownership.
