# Run GitHub reviews

The GitHub reviews plugin owns jobs requested through polling, agent tools and MCP, sharing one queue and worker limit. SQLite retains jobs, attempts and full reports; discovery and worker ownership stay in memory. Run one host per review data directory. Polling is the automatic trigger; the reviews service owns accepted work and execution.

To address reviews on your own PRs, use the separate [feedback workflow](./github-feedback.md).

## Configure the plugin

Supply your application’s review runner when registering the plugin:

```ts
import { githubReviews } from "@picco-agent/plugin-github-reviews";
import { z } from "zod";
import { runReview } from "./review.js";

const Report = z.object({ markdown: z.string() });
const reviews = githubReviews({
  runReview,
  enabled: true,
  repositories: [{ name: "example/widgets", skill: "review" }],
  maxConcurrentReviews: 2,
  resultSchema: Report,
});
```

Put `reviews` in the agent's `plugins` array. Authentication uses the host's GitHub CLI by default. The plugin polls on startup, validates personal review requests and checks the PR again before each execution. Open draft PRs are eligible for both automatic and explicit reviews; closed and merged PRs are excluded. A new commit does not trigger another automatic review unless a newer review request exists. Genuine failures and manual cancellations stay stopped until an explicit retry or a newer request. Known GitHub retry deadlines leave accepted work queued and delay further GitHub admission reads until the deadline; polling and queued execution resume automatically.

`enabled: false` disables automatic polling and execution of queued polling jobs. Explicit submissions remain available in either delivery mode. Removing a repository route also stops its queued automatic work. Runtime pause, poll timing and backoff reset after restart; permanent disablement belongs in configuration.

## Request a review through MCP

Picco core supplies the MCP transport. Enable `mcp` on `createAgent()` and register the reviews plugin normally:

```ts
const token = process.env.REVIEW_MCP_TOKEN;
if (!token) throw new Error("Set REVIEW_MCP_TOKEN");

const agent = createAgent({
  name: "reviews",
  dataDir: "./data",
  runtime,
  plugins: [reviews],
  mcp: { port: 8794, token },
});
await agent.start();
```

Here `createAgent` comes from `@picco-agent/core`; `runtime` is your configured runtime. Connect the client to `http://127.0.0.1:8794/mcp` with `Authorization: Bearer ...` using the configured token. The plugin defines its agent tools and MCP tools separately, with the same underlying service.

```json
{
  "name": "github_reviews_start",
  "arguments": {
    "repository": "example/widgets",
    "number": 42,
    "requestId": "widgets-42-first-review"
  }
}
```

The response contains a saved job ID, not a completed review. Reusing the request ID with the same inputs returns that job, including after restart; conflicting inputs are rejected. The repository and PR number identify the review; the callback receives the URL derived from that identity. During known GitHub backoff, new submissions report the retry deadline without additional API calls or an accepted job. Repeating an already accepted key still returns its job. Explicit submissions default to `delivery: "local-only"`, which suppresses GitHub publication and notification callbacks. Set `delivery: "publish"` in the start arguments to use the application’s publication workflow and notifications. Delivery is saved with the job and retained through retries and restarts; changing it requires a new request ID. Neither mode marks an automatic review request handled.

Use `github_reviews_details` with `{ "id": "<returned job ID>" }` to inspect its attempts, then `github_reviews_report` with the same ID to retrieve its latest full report. A queued job has no report yet. Failed attempts may retain partial evidence. Reports are bounded to 4 MiB.

## Return a review result

The required `runReview` callback receives the selected PR, pinned revisions, delivery mode and cancellation signal. It returns the final outcome for Picco to save:

Implement it as an ordinary async function. [Build workflows](./workflows.md) shows how that function can run model stages through Picco while keeping preparation, state and publication in application code.

```ts
const reviews = githubReviews({
  runReview: async (selection, signal) => {
    const report = await runWorkflow(selection, signal);
    return {
      status: "completed",
      summary: "Review complete",
      result: JSON.stringify(report),
    };
  },
});
```

Here `runWorkflow` is application code that prepares and runs the review, including any required publication. Picco validates and saves the returned report together with its outcome. Reports are bounded to 4 MiB. With `resultSchema`, completed reviews require a non-null report accepted by that schema. Failed outcomes can return an error and a partial report.

The callback runs for both delivery modes without opening a Picco session or calling a launcher model. It must honour the cancellation signal and await its worker's cleanup before returning or throwing. The original review deadline aborts that signal, and cancellation waits for the callback to settle before releasing the worker slot.

Use `onRunStart` and `onRunComplete` for notifications on published reviews. Notification failures do not repeat execution or change a saved successful outcome. Notification callbacks are bounded to 30 seconds; the review runner itself uses the original review deadline.

## Inspect, cancel and retry

`github_reviews_status` reports this process's poll health, API budget, pause state and active workers. `github_reviews_list` lists accepted jobs, rather than every discovered candidate. `github_reviews_pause` stops new execution while active work finishes; `github_reviews_resume` resumes it. Pause ends when the host restarts. `github_reviews_poll` requests discovery subject to enablement and API backoff.

`github_reviews_cancel` stops queued work or waits for active worker teardown. `github_reviews_retry` queues a fresh attempt of an unsuccessful job and retains earlier results. Retry while queued or active does not enqueue another attempt. A delayed duplicate retry after its attempt finishes can start another run; there is no per-command receipt protocol. Completed jobs require a new submission request ID or a newer automatic review request.

On crash or normal shutdown, unfinished attempts become interrupted and restart as new attempts at the current PR revisions. Completed, genuinely failed and manually cancelled jobs stay stopped. There is no workflow resumption, persistent dispatcher lease, publication claim or operator attestation. Do not run overlapping hosts against one directory.

Publication remains application policy. Best-effort reuse of the authenticated author's comment on the same PR and full commit can reduce duplicates after restart. GitHub publication and SQLite completion are separate operations, so this does not guarantee exactly-once comments.

The exported `GithubReviewsOptions` type is the configuration reference. See [Plugins](./plugins.md) for lifecycle.
