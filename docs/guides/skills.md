# Skills

A Pi skill is a directory of instructions and optional resources that the model loads when a task
needs them. Use skills for reusable procedures such as release preparation or incident triage.

## Add skills

```ts
const agent = createAgent({
  name: "assistant",
  runtime: local(),
  pi: {
    skills: ["./skills"],
  },
});
```

Each entry may be a skill file or directory. Picco resolves the path on the host; `bwrap()` mounts
it read-only inside the sandbox.

## Add a skill from a plugin

A plugin can append a skill for the sessions it configures:

```ts
configureSession(_session, pi) {
  return {
    ...pi,
    skills: [...(pi.skills ?? []), skillDirectory],
  };
}
```

Use the session source when a skill should apply only to some conversations.

## Choose between a skill and a tool

Use a skill when the model needs instructions or credential-free scripts inside the session. Use a
[host-side tool](./tools.md) when work requires operator credentials, privileged host access, or
shared host state.

Everything in a skill directory is readable by the model and session code. Never put credentials
in a skill.
