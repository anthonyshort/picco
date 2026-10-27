# @picco-agent/plugin-github-reviews

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
