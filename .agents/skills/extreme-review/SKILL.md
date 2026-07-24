---
name: extreme-review
description: Run a multi-session, file-by-file review of an entire repo with the user — tidy every file, build a reusable style ruleset, confirm the user understands every line, and simplify. Use when the user wants to review a whole codebase together, one file at a time. Automatically resumes an in-progress review when its state files are present.
---

# Extreme Review

A structured exercise for reviewing **every file in a repo**, one at a time, with the user. It runs across multiple sessions using three living documents as handoff state. The agent does all editing, quizzing, and note-taking; the user reviews, asks questions, and requests changes but does not edit code themselves.

## When invoked

Before anything else, check whether a review is already in progress: look for `HANDOFF.md`, `REVIEW.md`, and `REVIEW-NOTES.md` at the repo root.

- **If they exist, resume — do not re-run Setup and do not ask the calibration questions.** Read them in order (`HANDOFF.md` → `REVIEW-NOTES.md` → `REVIEW.md`); the calibration settings and accumulated rules are already recorded, so honor them. Take the current/next file from `REVIEW.md`'s status (🔵 in review, else the first ⬜), tell the user in one line where the review stands and which file is next, then continue the per-file process from there. Don't wait to be re-briefed — the docs are the brief.
- **If they don't exist, this is the first session:** run Setup.

## Goals

- Every line is written the way the user would write it.
- Produce a reusable set of rules/guidelines for future code (codified into `AGENTS.md` or skills at the end).
- The user understands every line of code.
- Simplify or remove code — the user knows the requirements and where features can be traded for simplicity.

## Non-goals

- **Architecture review.** Work on individual files only. Moving things is allowed; redesigning the system is not. Exception: when a file review surfaces a genuine architecture problem, the non-goal yields on explicit user opt-in — don't force it into the small-edits loop. Confirm intent, enter **plan mode**, research with Explore agents, resolve the key decision with the user, then implement or file an issue. The realignment becomes that file's review outcome.
- **API changes.** Keep module APIs intact by default so nothing breaks. Deviate only when necessary, and flag it.

## Setup (first session only)

1. Ask the user three calibration questions before starting:
   - **Review order** — bottom-up (leaves first), top-down (entry points first), or by package.
   - **File scope** — code+tests, code+tests+config, or literally everything.
   - **Quiz depth** — deep (trace logic) or light (key decisions).
2. Read any existing convention sources in the repo (e.g. `AGENTS.md`, `.agents/skills/*`) and seed the notes doc from them rather than starting blank.
3. Create the three documents (below) and build the manifest from `git ls-files`.

## The three documents

- **`HANDOFF.md`** — the brief: goals, non-goals, chosen settings, the per-file process, repo orientation, and pointers to the other two docs. Written so a fresh agent can take over cold.
- **`REVIEW.md`** — the manifest: every file with state (⬜ pending / 🔵 in review / ✅ reviewed) and the suggested order. Tracks which file is currently in review.
- **`REVIEW-NOTES.md`** — accumulated memory of the user's style, preferences, and rules, organized by category. Update whenever the user says something worth remembering; cite the originating file. This is the raw material for the final `AGENTS.md`/skill updates.

## Modes

The per-file loop below is the default. The user can drop a file tree to **batch mode** ("review them all at once") — typically for lower-risk trees (test harnesses, scripts, config, examples) once the rulebook is mature. In batch mode: review the whole set in one correctness-focused pass, apply the accumulated notes, skip the per-file back-and-forth and quizzes, commit per coherent unit, and write one self-contained log entry covering the set. The bar for findings does not drop — batch passes have caught real bugs; only the ceremony drops.

When the user is reviewing remotely (e.g. on a phone, no code in front of them), they review by **prose summary**: lead with what changed and why it matters, keep summaries self-contained (no "see the diff"), and record in the state docs that sign-off was summary-based. Offer to re-quiz later rather than pressing; note waived quizzes in the log.

## Per-file process

Do **not** skip steps or advance to the next file without the user's explicit OK.

1. **Review the file first** (with its tests as a unit where sensible). Look for glaring bugs and security issues. Gauge how well-tested it is.
2. **Apply the notes proactively.** Make the fixes the accumulated `REVIEW-NOTES.md` already implies, then tell the user what changed. Flag anything they should look at first; ask about anything uncertain.
3. **Ask the user to review.** Go back and forth. Update `REVIEW-NOTES.md` as they react. Do not move on until they say so.
4. **Quiz** (at the chosen depth) once the user is happy, to confirm understanding. Keep quizzing until they say they understand.
5. **Keep the build green.** Run the repo's validate command. Fix unrelated breakage together first (without deep-reviewing those files), then **commit** the file(s).
6. **Update `REVIEW.md`** (mark reviewed) and `REVIEW-NOTES.md` (latest notes).

**Close a package with its `package.json` + `README.md`** as the final step, right after its last src file — not batched to the end. The manifest and README are reviewed against the package's siblings (see below).

## Practices that keep the review honest

- **Ground requirement claims in the source of truth.** When the user says "it should work like X," read X directly (the wrapped tool's own docs), not our docs — ours may have drifted. When the tool's docs are silent, read its installed source in `node_modules`.
- **Audit a manifest, README, or barrel against its siblings.** Drift shows up as the one file that differs (a stray `dist/`, a lone `## API` section, an unexported param type).
- **Cross-cutting cleanups and API-name concerns become a GitHub issue**, not scope creep in the current file. Half-applying a repo-wide fix in one package is worse than filing it.
- **Never chain `git commit` onto the validate command.** Run validate, look at its exit code, then commit as a separate step. Both masking variants have shipped a commit on a red build: `| tail` hiding the failure, and `&&` keyed off an `echo` instead of validate itself.
- **Rotating single-test timeouts in integration are an environment signal, not a regression.** Failures that move between unrelated tests across re-runs, on a diff that can't reach them, mean transient slowness. Prove it — re-run (the failure moves), check the diff can't reach the failing suite — and get one clean full run before proceeding.
- **Rebuild a phase's manifest from `git ls-files` before opening it.** File lists written at setup rot as the repo is reorganized mid-review; a stale manifest sends you to files that no longer exist and hides the ones that replaced them.
- **Use the strongest verification available, not just the standard one.** If a reviewed script's real backing service happens to be up (a local model server, a live sandbox), run the real thing — a green live run proves what a typecheck can't.

## Closing (final session)

Take the accumulated `REVIEW-NOTES.md` and codify it into `AGENTS.md` and/or skills so future agents follow the guidelines. Then apply this skill's own process adjustments (below).

## Improving this skill

This exercise is expected to evolve. When something about the _process itself_ isn't working and the user adjusts it, record the change under "Process adjustments" in `REVIEW-NOTES.md` (not the style notes — those are about the code). At the end, fold those adjustments back into this SKILL.md so the next run starts from the improved process.
