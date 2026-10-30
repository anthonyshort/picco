# Run requested GitHub reviews

The GitHub reviews plugin polls review requests for the host's authenticated GitHub account and starts a session when an eligible pull request is ready. It records reviewed commits in SQLite so normal polling does not need to scan GitHub comments or reviews. An empty poll does not start a model session. It requires no repository webhook or GitHub App.

To address reviews on your own PRs, use the separate [feedback workflow](./github-feedback.md).

## Start a review assistant

Install Pi and the packages used by the assistant:

```sh
npm install @earendil-works/pi-coding-agent @picco-agent/core @picco-agent/plugin-github-reviews @picco-agent/runtime-local
```

Install the GitHub CLI and run `gh auth login` on the host. The account must be able to read each configured repository. An existing `GH_TOKEN` or `GITHUB_TOKEN` takes precedence over the CLI's saved sign-in.

Create a `review` skill under `./skills` that describes how to inspect and publish a review. The plugin selects work and manages execution; the skill decides how to review it. See [Skills](./skills.md) for the skill layout.

```ts
import { createAgent } from "@picco-agent/core";
import { githubReviews } from "@picco-agent/plugin-github-reviews";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "review-assistant",
  dataDir: "./data",
  runtime: local(),
  pi: { skills: ["./skills"] },
  plugins: [
    githubReviews({
      enabled: true,
      repositories: [
        { name: "owner/server", skill: "review" },
        { name: "owner/web", skill: "review" },
      ],
      maxConcurrentReviews: 3,
    }),
  ],
});

await agent.start();
```

Run the assistant with the model credentials your Pi configuration needs. Setting `enabled: true` permits automatic review sessions, including any publication authorised by the configured skill. Omit it while preparing configuration or inspecting persisted state.

For an unconfigured installation, register `githubReviews({})`. It starts disabled with no repository routes, exposes management tools and initialises its database without calling GitHub or starting review workers. Add repository routes before enabling it. Applications loading settings from a file can use the exported `GithubReviewsSettingsSchema` to validate the same defaults and limits as the plugin.

The host CLI sign-in supplies discovery credentials. Review sessions use the agent's configured runtime and inherit its existing authentication setup. A sandbox must already provide the GitHub tools, repository access and credentials that the review skill needs; this plugin does not add mounts or copy the host credential store into a worker. See [Runtime isolation](./runtimes/index.md).

## Select eligible work

The plugin polls once a minute by default and discovers open, non-draft pull requests created within the last 28 days that request the authenticated user's review. It checks the current personal request before admission, so a team-only request does not start a review. Configure `maxPrAgeDays` when the repository needs a different creation window.

Candidates from all configured repositories share one queue, ordered by creation time, then repository and pull request number. The plugin checks current head and request state again before starting a session. A queued pull request that closes, becomes a draft or loses its request is no longer admitted.

The database records which commit the assistant reviewed for each personal request cycle. The same commit is not reviewed again unless a strictly newer personal request makes it eligible. A new head is eligible while your personal review is still requested. Normal discovery does not scan GitHub review history or infer a reviewed commit from comments.

GraphQL combines repository discovery and returns API budget information. Targeted GraphQL reads confirm the live head, personal request and request-cycle evidence. The request event's opaque node ID identifies the cycle; it is not decoded or treated as a REST numeric identifier. Polls do not overlap, and failures back off rather than being interpreted as an empty queue. Shorter polling intervals increase API use; inspect status before reducing the interval.

## Keep review state

The plugin stores queue items, claims, attempts, reviewed commits, pause state and poll status in one `reviews.sqlite` under its private plugin data directory. Set `reviewsDirectory` to place the database and review artifacts in a different persistent directory.

Keep that directory across restarts. SQLite may also create WAL and shared-memory sidecar files. Take a consistent SQLite backup rather than copying only the database file while the assistant is writing.

Each review has a unique run and artifact directory, which becomes the session's working directory. Reports and publisher progress remain files; the database records their association with the run. Concurrent sessions cannot reserve the same pull request, including different heads or request cycles.

On restart, persisted attempts are reconciled before new work is admitted. Interrupted reviews with uncertain remote effects remain blocked for inspection. A saved running record does not by itself mean a worker is still alive. A second dispatcher cannot take over an expired lease while the old host process is still alive. Moving a database between hosts requires stopping its writer and clearing or reconciling the old dispatcher ownership; lease expiry alone does not prove that its workers stopped.

This package does not automatically import an application's old claim database or completion JSON. Run any one-time historical seeding script in the consuming application before enabling admissions, and stop the previous review dispatcher so both systems cannot admit the same pull request. Starting with an empty database can review requests that an earlier assistant already handled.

The canonical `reviewed_commits` table is separate from queue items and worker attempts. A seeding script can insert historical evidence without inventing a run. Stop writers, initialise the plugin database with admissions disabled, and check `schema_migrations` version `1` before writing. Insert normalised lowercase `reviewer`, `repository` and commit `head`, the integer PR `number`, and the original UTC ISO `reviewedAt`. Use an empty string for `requestEventId` when the old request cycle is unknown, and leave `runId` null; an optional `summary` can record the source comment URL. The composite key is `(reviewer, repository, number, head, requestEventId)`. An idempotent importer should preserve existing records rather than replacing newer evidence. A strictly newer personal request can supersede an imported completion timestamp.

The script that finds old review comments belongs to the consuming application. The plugin never scans those comments during normal operation.

## Record a completed review

A review session receives a session-only `github_review_complete` tool. Its default prompt tells the worker to call this tool with a summary after the entire configured skill succeeds, including any publication required by that skill. The tool records the selected commit and request cycle as reviewed; it does not post to GitHub or independently verify remote publication.

If you supply a custom `prompt`, retain this completion instruction. A worker's final text alone does not mark the commit reviewed. The tool is bound to its selected session, so a different conversation cannot complete the review.

The worker is closed before its run finishes. A failed or incomplete workflow remains blocked for reconciliation. A local completion record and a remote GitHub write cannot be one transaction; the database records the worker's explicit declaration of success, not proof of remote delivery.

Use `onRunStart` to notify the user when an eligible request has been reserved and its worker is about to start. It receives the same selection as the prompt builder. The callback is awaited for up to 30 seconds while the reservation remains held. Failure or timeout is logged and the review continues; the callback is not retried. A timed-out callback can still finish later. This reports an admitted review, not every newly discovered request, and worker startup can still fail afterwards.

Use `onRunComplete` to report a durable outcome to an application log or notification system. The plugin records the callback attempt before invoking it and does not automatically repeat an uncertain attempt. Callback failures are visible in run details and do not make a recorded review eligible again. The application still owns its notification destination and message.

## Run a saved Pi workflow

A custom review prompt can launch a saved workflow through `SubagentWorkflow`. Install pi-subagents and the saved workflow in the worker's Pi profile, and supply the arguments that workflow requires. Set `holdWorkflows: true` on `githubReviews()` to track accepted launches through Picco's execution holds. Applications do not need a separate tracking plugin.

The initial task ID acknowledges launch, not completion. The parent should yield and wait for the completion notification, then inspect the result and verify required GitHub publication before calling `github_review_complete`. A completed workflow task does not by itself prove publication. Do not poll, rerun the workflow or repeat an uncertain remote write.

The review execution stays active until all tracked workflows finish and the parent follow-up settles. Its original deadline and cancellation signal still apply, and it keeps its review concurrency slot throughout. Failed or stopped workflows fail the execution. Picco retires the worker before the next queued turn so detached tasks cannot reuse its authority.

The setting defaults to `false` and does not change which workflow the prompt launches. When enabled, tracking is limited to this plugin's review sessions and creates no holds unless a saved workflow launches. A consumer using a local workflow-tracking adapter should remove it after upgrading and enabling this setting; the package then owns that behaviour.

## Inspect and pause work

Ask the assistant to inspect `github_reviews_status` for the last successful poll, API budget, admission state, active work and blockers. `github_reviews_list` shows candidate state; `github_reviews_details` shows an item's attempts and recorded completion.

Use `github_reviews_pause` to stop new admissions while active reviews finish. The pause survives a restart. Discovery remains available for status inspection. Use `github_reviews_resume` to clear the pause; it cannot override configuration with `enabled: false` or release uncertain publication reservations.

`github_reviews_poll` requests an immediate poll through the normal checks. It does not bypass rate limits, concurrency or a pause. For safe maintenance, pause admissions and wait for active work to finish before stopping the assistant or moving its database.

For an interrupted run, inspect its artifacts and GitHub before using `github_reviews_resolve`. Choose `completed` only when you have confirmed the review finished. Choose `retry` only after confirming the old worker has stopped and another attempt will not duplicate remote effects. Supply a reason recording that evidence. When marking a run completed without a saved completion declaration, also supply `reviewedAt` with the verified original UTC completion timestamp. It must be no earlier than the run’s start second and no later than the current time. This allows GitHub timestamps with second precision. Do not use the time of resolution: an intervening request for the same commit must remain eligible. Existing completion declarations keep their recorded timestamp. The next poll revalidates a permitted retry; resolving it does not directly start a session.

The exported `GithubReviewsOptions` type is the configuration reference. See [Plugins](./plugins.md) for plugin lifecycle and [Sessions](../concepts/sessions.md) for worker ownership.
