---
name: create-pr
description: Create a changeset, draft PR description, and open a draft PR
---

## When to use

- Finishing a feature or fix and ready to open a PR.
- The user asks to "open a PR", "create a PR", or "write a changeset".
- You need to write a changeset entry and push a branch for review.

## Prerequisites

- Working tree is clean except for the changes on the current branch.
- `pnpm validate` passes (build, format, typecheck, lint, tests).

Run validation first. If it fails, fix issues before continuing.

```bash
pnpm validate
```

## Step 1: Write the changeset

```bash
pnpm changeset
```

The CLI prompts for:

1. **Release type** — `major` / `minor` / `patch`. Use `patch` for fixes, `minor` for new features.
2. **Which packages changed** — select the packages with user-facing changes.
3. **Summary** — one line describing the change (this becomes the changelog entry).

Keep the summary short and concrete. Lead with what changed, not why.

**Good:** `Rename workspace option to dataDir with ~/.picco default`
**Bad:** `This PR makes some improvements to the agent configuration system`

After the changeset is written, review the generated `.changeset/*.md` file. The first line is the changelog summary — make sure it reads well standalone.

## Step 2: Stage and commit

Commit the changes (including the changeset file) with a conventional commit message:

```bash
git add -A
git commit -m "feat: <short description of what changed>"
```

Use `feat:`, `fix:`, `chore:`, `refactor:`, `docs:` — lowercase, no period at the end. Keep the title simple and focused on the user-visible change. No internal symbol names. Split with `+` only if the single title can't cover it.

## Step 3: Push and open a draft PR

```bash
git push -u origin <branch>
```

Build the PR body (see Step 4) and create the draft PR:

```bash
gh pr create \
  --draft \
  --title "feat: <short description>" \
  --body "$(cat <<'EOF'
<PR body from Step 4>
EOF
)"
```

## Step 4: Write the PR body

Apply these rules from the technical-writing baseline: lead with the definition or result, use short declarative sentences, state rationale only when it changes a decision, and remove throat-clearing or self-commentary.

### Template

Use a 4-backtick fence around the template so nested code blocks render correctly.

````
Short sentence explaining what this PR does.

- **<feature>**: one or two sentences on what it does and why
- **<feature>**: ...

## Why

Bullet list explaining why this PR is needed. Keep it short.

## Usage

```ts
// concrete consumer-side usage with inputs/outputs
```

## What I've tested

- [x] `pnpm validate` passes
- [x] <specific manual or integration check performed>
````

Drop any section that doesn't apply. If there's no consumer API change, omit the Usage section.

### Body rules

- **Concise** — no multi-paragraph background. Lead with what changed.
- **Bold-feature bullets** — `- **feature**: what it does and why`.
- **Consumer API sample** — include a code sample with concrete inputs/outputs when the PR changes a public surface.
- **What I've tested** — short list of checks already performed (not a checklist for the reviewer).

### Minimise inline code in prose

PR bodies are read by people, not parsed by machines. Avoid backtick-wrapped identifiers in the middle of sentences. Use plain text, bold, or a standalone code block instead.

**Good:**

> The `dataDir` option replaces `workspace`.

**Better:**

> The **dataDir** option replaces **workspace**.

**Bad:**

> Changed `createAgent()` to accept `dataDir` instead of `workspace`, updated `AgentPaths.resolve()` to use `os.homedir()`, and the `sessions/` directory now defaults to `~/.picco/{name}/sessions/`.

That sentence is unreadable. Rewrite it:

> The **dataDir** option replaces **workspace**. Sessions now default to **~/.picco/{name}/sessions/**.

Reserve inline code for the Usage section where readers expect it.

### Draft the body from the diff

Gather the changes since the branch diverged:

```bash
base="$(git merge-base HEAD origin/main)"
git log --reverse "$base"..HEAD
git diff "$base"..HEAD
```

Read the commits AND the diff — don't summarise from commit messages alone.

### Print and confirm

Print the proposed PR body to the user and ask for confirmation before creating the PR. If they suggest edits, revise and ask again.

## Step 5: Confirm

Print the PR URL so the user can open it:

```
PR created (draft): <url>
```

## Full example flow

```bash
# 1. Validate
pnpm validate

# 2. Write changeset (interactive)
pnpm changeset

# 3. Commit
git add -A
git commit -m "feat: rename workspace to dataDir with default path"

# 4. Push
git push -u origin feat/rename-workspace

# 5. Create draft PR
gh pr create --draft \
  --title "feat: rename workspace to dataDir with default path" \
  --body "$(cat <<'EOF'
Rename the **workspace** option to **dataDir** with a **~/.picco** default.

- **dataDir option**: replaces **workspace** with cross-platform default (**~/.picco** via **os.homedir()**)
- **AgentPaths module**: centralises path construction, eliminates duplicated **path.join** calls

## Why

The **workspace** name implied a Git workspace. **dataDir** makes clear this is the agent's data directory.

## Usage

\`\`\`ts
// Before
const agent = createAgent({ workspace: "/srv/bot", runtime: bwrap() });

// After
const agent = createAgent({ dataDir: "/srv/bot", runtime: bwrap() });
// or — defaults to ~/.picco
const agent = createAgent({ runtime: bwrap() });
\`\`\`

## What I've tested

- [x] \`pnpm validate\` passes
- [x] Sessions created under \`~/.picco/{name}/sessions/\`
EOF
)"
```
