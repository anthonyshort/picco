# @picco-agent/plugin-github-reviews

## 0.6.0

### Minor Changes

- f3f8765: Allow manual tool and MCP review requests to choose publishing delivery, retaining local-only as the default. Preserve delivery through retries and restarts, and reject request-ID reuse with changed delivery.

## 0.5.1

### Patch Changes

- d66125b: Accept open draft pull requests in review discovery, live eligibility checks and explicit submissions.

## 0.5.0

### Minor Changes

- e7934f8: Run automatic review requests through accepted jobs and attempts. Keep discovery state in memory, save final reports atomically with their outcomes, and start fresh attempts after shutdown.
- 55ccb25: Expose local-only review submission and management through agent and MCP tools. Reuse the shared review service, retain client request IDs across restarts, and return full saved reports.

### Patch Changes

- Updated dependencies [5214fb6]
- Updated dependencies [9de084d]
  - @picco-agent/core@0.5.1

## 0.4.3

### Patch Changes

- Updated dependencies [8237bf1]
  - @picco-agent/core@0.5.0

## 0.4.2

### Patch Changes

- 5282f79: Require a new personal review request before reviewing later commits on an already reviewed pull request. Preserve prior attempt blockers across commits until a newer request or explicit retry resolution permits another attempt.

## 0.4.1

### Patch Changes

- c5dfaad: Allow review and feedback dispatchers to restart immediately when the previous owning process on the same host has exited. Keep blocking live processes, other hosts and uncertain process checks, and preserve interrupted work for inspection.

## 0.4.0

### Minor Changes

- cadb400: Add an opt-in holdWorkflows setting that keeps saved Pi workflows and their parent follow-up inside the original review execution so background publication retains tool authority.

## 0.3.2

### Patch Changes

- Updated dependencies [a6d3f12]
  - @picco-agent/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [c582315]
  - @picco-agent/core@0.3.2

## 0.3.0

### Minor Changes

- f37911d: Add automatic handling of submitted reviews on authored PRs, with persistent debouncing, separate feedback state and retryable skill artifacts.

## 0.2.0

### Minor Changes

- 504452f: Add an optional onRunStart callback so applications can notify users before a reserved review starts. Callback failures and timeouts are logged without preventing the review or retrying delivery.

### Patch Changes

- dcd874e: Use GitHub advanced issue search for nested repository filters so requested pull requests are discovered across configured repositories.

## 0.1.2

### Patch Changes

- @picco-agent/core@0.3.1

## 0.1.1

### Patch Changes

- e65ef39: Allow an unconfigured review plugin to start disabled with no repositories, keeping management tools available without calling GitHub. Export the settings schema so applications can validate configuration without copying its defaults and limits. Enabling reviews still requires at least one repository route.

## 0.1.0

### Minor Changes

- 959f066: Add a GitHub review polling plugin with GraphQL discovery, a persistent SQLite queue, bounded review sessions and review status tools. It uses the host GitHub CLI sign-in without requiring repository webhooks or a GitHub App.

### Patch Changes

- Updated dependencies [2ace4f6]
- Updated dependencies [10eda2f]
- Updated dependencies [4dda0ad]
  - @picco-agent/core@0.3.0
