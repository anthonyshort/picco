# Documentation

Follow `.agents/skills/technical-writing/SKILL.md`.

## Purpose

Documentation helps readers:

1. Start a working assistant.
2. Understand Picco's architecture and ownership boundaries.
3. Build common configurations and integrations.

It is not an API or configuration reference. Be comprehensive at the task level and selective at
the API level. Exported types and implementation are the authoritative reference.

## Information architecture

- `index.md` routes readers through Start, Understand, and Build.
- `getting-started.md` owns the shortest complete path to a working result.
- `concepts/` explains architecture, sessions, the filesystem, and security.
- `guides/` teaches concrete configuration and implementation tasks.
- The root README introduces the project; it does not duplicate the documentation index.
- Package READMEs are package cards; they do not own framework documentation.

Give each page one primary job. Explain each idea fully in one canonical page, then link to it from
other pages.

## Content

- Document shipped behaviour only. Keep roadmap material in issues.
- Verify Picco claims against source and tests.
- Verify Pi claims against its installed documentation or source.
- Include an option when the task requires it, it is commonly useful, or it changes an important
  choice, failure mode, lifecycle rule, or security boundary.
- Do not reproduce complete interfaces, option lists, or defaults from the types.
- Prefer public behaviour over package layout and other implementation detail.
- Use “assistant” for what a person builds and “agent” for API and implementation concepts.

## Examples

- Start with the smallest example that demonstrates the task.
- Complete examples include every required import and configuration field.
- Make it clear from the surrounding text when an example is a partial configuration or method
  body.
- Keep credentials in environment variables and state the variables the example needs.
- Explain only behaviour that is not already visible in the code.

## Navigation and style

- Use relative links for files in this repository.
- Use literal or task-oriented headings.
- Link to the canonical page instead of repeating its explanation.
- Add related links only when they are useful at that point in the workflow.
- Use British spelling.
- Repeat a concise security warning at the point of action when omitting it could cause harm.
