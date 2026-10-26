# GitHub review request source

Private workspace package for reading personal GitHub review requests through the authenticated host GitHub CLI. All reads use GraphQL.

The source discovers candidates across configured repositories and revalidates the live head, personal request and request cycle. It performs no polling, database writes, model turns or GitHub mutations.

Run its source tests with `pnpm exec vitest run packages/plugin-github-reviews/src/github.test.ts`.
