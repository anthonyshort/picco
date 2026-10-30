# @picco-agent/plugin-github-reviews

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
