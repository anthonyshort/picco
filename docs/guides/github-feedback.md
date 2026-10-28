# Address feedback on authored pull requests

`githubFeedback()` watches submitted reviews on the authenticated account’s open pull requests and runs a skill to address them. It can run alongside `githubReviews()`, which handles requests to review other people’s changes.

Register the plugin and make the feedback skill available to Pi:

```ts
import { githubFeedback } from "@picco-agent/plugin-github-reviews";

const feedback = githubFeedback({
  enabled: true,
  skill: "address-pr-feedback",
});
```

Add `feedback` to the agent’s plugins. The host needs the GitHub CLI and authentication; workers need Git, repository access, and the tools and credentials required by the skill. The plugin adds no sandbox mounts or credentials. See [GitHub reviews](./github-reviews.md) for agent setup and [Skills](./skills.md) for skill registration.

## Batch submitted reviews

Discovery includes all accessible open PRs authored by the authenticated account, including drafts and older PRs. Submitted reviews from people and bots are eligible. Self-reviews, pending or dismissed reviews, and approvals without text or inline comments are excluded. Ordinary PR comments and thread replies do not trigger work; the skill reads them for context.

Existing reviews enter the queue when first discovered. By default the plugin polls every minute and starts work after ten minutes without another eligible review on that PR, or thirty minutes after the first pending review was discovered. Worker availability and API backoff can delay admission further. The timestamps survive restart. An edit to a processed review does not trigger another pass.

Only one feedback worker runs at a time. Each run receives an immutable batch of review IDs. Reviews arriving during that run remain pending for a later pass. Processed IDs are independent of commit hashes, so a worker’s own push does not repeat the work. An empty poll starts no model session.

## Let the skill handle changes

The default prompt instructs the selected skill to use an isolated checkout of the PR’s actual head repository and branch, verify the starting head, and stop if it moves before pushing. The skill owns triage, delegation, checks, committing, pushing and publication. The supplied `address-pr-feedback` workflow updates a progress comment, reacts to addressed inline comments and leaves review threads unresolved.

A worker calls its session-only `github_feedback_complete` tool after the entire skill succeeds. It supplies a summary and, where applicable, the pushed commit and progress comment URL. Successful triage can complete without code changes. Final text alone does not complete a run. Completion records the worker’s declaration, not independent proof of a remote GitHub write.

Applications can supply `prompt`, `onRunStart` and `onRunComplete` callbacks. Preserve the completion instruction when replacing the prompt. Callbacks have a bounded delivery deadline; delivery failures are logged and do not repeat feedback work.

## Inspect and recover work

The plugin defaults to disabled. Its `github_feedback_status`, `github_feedback_list` and `github_feedback_details` tools expose discovery, queues and saved attempt evidence. `github_feedback_pause` persistently stops admissions while discovery continues; `github_feedback_resume` clears that pause. `github_feedback_poll` respects debounce and API backoff.

Queue state lives in `feedback.sqlite`; artifacts live under `runs/` in the plugin’s data directory. Set `feedbackDirectory` to choose another persistent location. Keep both database and artifacts across restarts, and stop writers before moving them. Back up SQLite consistently, including its WAL state.

A failed or interrupted attempt blocks further work on that PR. Inspect the saved checkout, progress state, remote commits and comment before calling `github_feedback_resolve`. Mark it `completed` when the batch was handled, or choose `retry` after confirming the old worker stopped. Record the evidence in `reason`.

A retry reuses the original batch and artifact directory; newer reviews wait for a fresh run. When fixes were already pushed, repair the missing publication or reactions rather than repeating the fixes. The skill’s progress helper can republish saved state with its `sync` command. Neither a restart nor lease expiry proves an earlier remote write failed.

If worker teardown cannot be confirmed, all feedback admissions pause until the operator reconciles the worker and resumes them. The feedback skill’s helper cannot reopen a finalised checklist: a retry needing further code work may remain blocked and require a manually prepared new pass. Publication repair does not require reopening the checklist.

The exported `GithubFeedbackOptions` type and `GithubFeedbackSettingsSchema` define supported configuration.
