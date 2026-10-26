# GitHub review state

Private workspace package for reading personal GitHub review requests through GraphQL and storing review workflow state in SQLite.

The source discovers candidates and revalidates their head, personal request and request cycle using the authenticated host GitHub CLI. It performs no GitHub mutations.

The store owns the queue, reviewed-commit history, PR reservations, run outcomes and persistent pause/poll state in one database. Database creation occurs only when the store factory is called. Merely importing this package starts no polling or model sessions.

Run its tests with `pnpm exec vitest run packages/plugin-github-reviews`.
