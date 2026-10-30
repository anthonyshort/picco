# Execution hold implementation and local proof

Core supports generic execution observers and holds. The Pi-subagents adapter lives in `integration/src/workflow-observer.ts` as an integration fixture; consumer configuration is a separate release step.

## What changed

Core calls each plugin's `prepareExecution` hook before sending a prompt and processes structured worker events synchronously. Holds keep the original execution running through background work. Completing a hold releases it; the execution waits until all holds are released and the worker is settled. One deadline covers waiting, continuation and final-text retrieval.

Detached-work holds explicitly request worker retirement. Picco revokes the session token and stops the worker before resolving the turn and advancing its queue. Ordinary host holds keep the warm worker. Existing bridge admission, draining and finalisation remain in place.

The adapter validates accepted `SubagentWorkflow` launch results, matches tool-call IDs and tracks task IDs. It consumes the existing `subagent-notification` custom messages, including batched `others`, and releases successful tasks' holds on the following worker settlement. This keeps the parent's completion declaration inside the execution without putting continuation-specific options in core. It filters for `github-reviews` sessions. Duplicate completions are ignored; malformed launches, reused task IDs and terminal workflow failures reject the operation.

## Reproduce the workflow regression

Use Pi 1.4.0 and pi-subagents 0.22.0 in an independent temporary installation. Core remains built from this checkout. This avoids changing the running consumer's package tree.

```sh
npm install --prefix /tmp/picco-workflow-proof --ignore-scripts \
  @earendil-works/pi-coding-agent@1.4.0 @tintinweb/pi-subagents@0.22.0
pnpm build
PICCO_PI_BIN=/tmp/picco-workflow-proof/node_modules/.bin/pi \
PICCO_SUBAGENTS_EXTENSION=/tmp/picco-workflow-proof/node_modules/@tintinweb/pi-subagents/dist/index.js \
  pnpm exec vitest run integration/src/workflow.test.ts
```

`PICCO_PI_BIN` selects the worker executable through its spawn environment, avoiding pnpm's local-bin precedence. It must point to an executable named `pi`; other filenames are rejected. The test reports the version resolved from the same PATH passed to its worker. `PICCO_SUBAGENTS_EXTENSION` is required for these acceptance cases. They skip when it is absent because pi-subagents is an optional integration, not a core dependency. An invalid configured path must fail the tests. The repository's ordinary Pi development dependency remains 1.0.0; the saved-workflow proof specifically uses the consumer's Pi 1.4.0 and pi-subagents 0.22.0.

The controlled fake model starts a real saved workflow and blocks its child until after the parent's first settlement. Both acceptance cases passed locally:

- Without holds, the detached child's fake publication receives HTTP 409 and the host publication callback never runs.
- With holds, the child's fake `github_comment` and the parent's fake `github_review_complete` execute under the original execution ID. Publication precedes declaration, declaration precedes finalisation, final text comes from the continuation and the detached worker is retired before the turn returns.

Observed event order with the installed versions was launch tool result, initial settlement, continuation start, custom completion message and final settlement. The test uses controlled promises rather than waiting for a quiet interval.

No remote model requests, real GitHub publications, notifications or service restarts are involved. Only the fake model and local bridge listen on temporary loopback ports.

## Other regression evidence

Focused tests cover parallel and sequential holds, batched and duplicate completions, terminal errors, malformed launches, cancellation, reset, deadlines and worker retirement. The queued-sender test uses a real ToolBridge: after the second sender becomes active, the old worker's token receives HTTP 401. RPC tests also start and settle a continuation while final-text retrieval is pending, then verify the final reply is retrieved again. A hung final-text request remains bounded by the original deadline.

`pnpm validate` passed build, formatting, type checks, lint, 695 unit tests and 36 integration tests. The saved-workflow cases ran with Pi 1.4.0 and `PICCO_SUBAGENTS_EXTENSION` configured, rather than skipping. They also passed against the repository's Pi 1.0.0. Bubblewrap integration used a temporary outer sandbox to expose installed Pi and Node under `/usr/local`, without changing host installation or skipping required bubblewrap cases.

## Remaining release work

After releasing core, update the isolated agent's published dependency and configure the adapter for its dedicated review sessions. The running server and installed consumer packages have not changed.

The local proof establishes execution ownership and notification ordering for the tested versions. It does not validate a real review, GitHub delivery, persisted-session resumption after a detached worker retires, or arbitrary future pi-subagents versions. Runtime process-tree cleanup remains the runtime's responsibility; token revocation fences surviving descendants from future host authority.
