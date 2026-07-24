# Working in this repo

- `pnpm validate` (build, format, typecheck, lint, and full tests) must pass before every commit.
- Integration tests can be run separately using `pnpm test:integration`.
- Skills live in the `.agents/skills` directory.

# Principles

The codebase optimizes for code that can't quietly rot: one home per fact, honest names and types, no unearned abstraction, no dead weight.

- **Names tell the truth.** A name states what a thing is, not an approximation — a plausible-but-inaccurate name is a defect.
- **New code is indistinguishable from existing code.** Match the house style; audit new files, manifests, and docs against their siblings.
- **Abstractions are earned.** No abstraction before a second caller, no seam before the refactor that needs it; defer to the underlying tool instead of wrapping it.
- **Structure follows ownership.** One module per file; code and data live where they're owned and discovered.
- **Minimal by default.** The least code that meets the requirement; delete dead code on sight; don't over-guard trusted input.

# Writing style

Follow `.agents/skills/technical-writing/SKILL.md` for documentation reviews and rewrites.

Documentation teaches concepts and common workflows; it is not an API or configuration reference.
Do not enumerate every type member or option. Include details required for the task, commonly useful
choices, and consequential constraints. Exported types and implementation are the authoritative
reference.

The root README introduces the project and routes readers. Detailed usage belongs in `docs/`.

# Code style and conventions

Follow `.agents/skills/code-conventions/SKILL.md` for file ordering, comment styling, naming, types, request validation, and testing conventions.
