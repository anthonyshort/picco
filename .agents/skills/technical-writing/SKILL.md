---
name: technical-writing
description: Review, restructure, and edit technical documentation into a concise, neutral baseline for engineers. Use writing documentation.
---

# Technical Writing

Create a structurally sound, readable technical baseline. Optimize first for comprehension, navigation, and reference use. Treat distinctive voice as a later editing pass.

## Establish the job of the documentation

Identify before editing:

- The audience and what they already know.
- The tasks readers need to complete.
- The concepts readers need before completing those tasks.
- Whether each document is a tutorial, how-to guide, explanation, or reference.

Do not make every page serve every purpose. Assign each page one primary job.

When reviewing a documentation set, map it into these modes where applicable:

1. **Start**: get to a working result quickly.
2. **Understand**: explain the architecture, vocabulary, and mental model.
3. **Build**: guide concrete implementation tasks.
4. **Reference**: provide signatures, options, defaults, and exact behavior.

## Audit before rewriting

Read the full material in scope. Inspect headings, word counts, page openings, repeated phrases, code examples, and navigation.

Record:

- Concepts explained fully in more than one place.
- Pages with overlapping responsibilities.
- Long introductions that preview or defend the page instead of starting it.
- Paragraphs that combine definition, rationale, contrast, and warning.
- Prose that narrates visible code.
- Guide prose embedded in API reference material.
- Important constraints hidden inside rhetorical paragraphs.
- Repeated conclusions, next-step lists, or security arguments.

Do not check implementation accuracy unless the user asks. Preserve claims as claims and focus on presentation.

## Assign each idea one home

Choose a canonical page for every major concept. Explain it fully there. Elsewhere, use a short reminder and a link.

Common canonical homes:

- Design rationale in an explanation or principles page.
- Component definitions and lifecycle in an architecture page.
- Procedures and examples in task guides.
- Types, fields, defaults, errors, and ordering in the API reference.

Do not re-argue a design choice on every page that touches it.

## Package READMEs

A package README is a card, not a documentation home. Give it a one-line description, install, a minimal usage example, and links to the canonical docs — in that shape, matching the sibling package READMEs in the repo. A link stays current; a copied reference drifts. Install the companion package the usage example needs so it runs as written.

While the API is in flux, do not maintain a member-by-member API reference at all — it rots (a drifted one once documented seven nonexistent helpers). The conceptual guides are the documentation; the TypeScript types are the reference.

Use British spellings throughout docs, comments, and identifiers: `-ise`/`-isation`, `behaviour`, `colour`, `serialise`, `catalogue`, `initialise`. Keep `cipher`.

## Restructure around reader tasks

Use this default guide shape:

1. Direct definition.
2. Minimal working example.
3. Important behavior and constraints.
4. Common patterns or decisions.
5. Link to exact API reference.

Split a page when distinct readers would visit it for distinct tasks. Keep related material together when splitting would force readers to reconstruct one workflow across several pages.

Prefer:

- Tables for comparisons, mappings, options, and repeated field descriptions.
- Diagrams only for architecture, lifecycle, ownership, or data flow that prose cannot show as clearly.
- Task-oriented headings such as “Persist data across sessions.”
- Literal headings such as “System instructions” over editorial headings such as “The voice.”

## Tighten examples

Start with the smallest example that demonstrates the abstraction.

After a code block, explain only behavior that is not obvious from the code. Remove “In this example” lists that merely restate property names and values. Prefer a short code comment when it can replace a prose bullet.

Keep a larger example only when it demonstrates an important composition pattern. Move complete application examples out of concept or reference pages when they dominate the abstraction being taught.

## Tighten prose

Apply these rules in order:

1. Lead with the definition, behavior, result, or instruction.
2. Keep one main idea per paragraph.
3. Prefer short declarative sentences.
4. State rationale only when it changes a decision or prevents a mistake.
5. Remove arguments against alternatives unless the tradeoff is actionable.
6. Replace metaphor with mechanism in guides and reference pages.
7. Remove throat-clearing, self-commentary, and claims of importance.
8. Reserve bold text for terms, critical constraints, and warnings.
9. Preserve precise caveats, failure modes, security boundaries, and lifecycle behavior.
10. Avoid adding personality during this pass.

Treat these phrases as signals to inspect, not as banned words:

- “on purpose” or “deliberately”
- “this matters because”
- “worth noting” or “worth internalizing”
- “be honest with yourself”
- “that’s the whole…”
- “exactly where … belongs”
- “the distinction that decides everything”
- “a typo fails at boot, not at 3am”

Replace rhetoric with the concrete behavior it was emphasizing.

Examples:

> Construction and boot are deliberately separate steps. `createAgent` only validates and wires; nothing touches the network until you call `start()`.

becomes:

> `createAgent()` validates configuration. `start()` starts adapters and plugins.

> One naming note, honestly: identity is the concept, but the config key and package still say `connections`.

becomes:

> The documentation calls the concept “identity.” The API uses `connections`.

## Protect useful information

Compression is not the same as deletion. Keep information that answers at least one of these questions:

- What should the reader write or run?
- What behavior must the reader account for?
- How should the reader choose between realistic options?
- What non-obvious failure, lifecycle rule, or security boundary matters?
- Where can the reader find the exact interface or field?

If a sentence answers none of them, remove it or justify its role in conceptual orientation.

Do not remove repetition that is required for safety at the point of action. A short warning beside a dangerous option may repeat a canonical security explanation.

A stale or inaccurate note may encode an unresolved decision. Before deleting it, identify the decision it gestures at and preserve that — often as a tracked issue — rather than just cutting the line.

## Separate baseline clarity from voice

Complete the structural and compression pass before adding voice. The baseline should sound neutral, direct, and technically competent.

In a later voice pass, add personality selectively to introductions, transitions, and memorable summaries. Do not add voice back into option tables, warnings, API descriptions, or procedural steps if it makes them longer or less exact.

## Choose the output

For a review request, provide:

1. A concise diagnosis of the dominant problems.
2. A proposed information architecture.
3. Prioritized page- or section-level changes.
4. A short house style tailored to the material.
5. Several representative before-and-after edits.
6. Optional reduction targets, labeled as estimates.

Support recommendations with concrete locations in the material. Prioritize systemic changes over exhaustive sentence edits.

For an editing request:

1. Preserve the existing technical meaning and Markdown conventions.
2. Restructure before polishing sentences.
3. Edit in coherent page-sized units.
4. Check links, headings, code fences, and terminology after editing.
5. Report major structural changes and any content whose intended meaning remained ambiguous.

Do not edit files when the user asks only for a review or suggestions.
