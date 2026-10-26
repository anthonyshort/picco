# `@picco-agent/plugin-github-reviews`

Poll personal GitHub review requests and run review sessions from a persistent queue.

## Install

```sh
npm install @picco-agent/core @picco-agent/plugin-github-reviews @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { githubReviews } from "@picco-agent/plugin-github-reviews";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "review-assistant",
  runtime: local(),
  pi: { skills: ["./skills"] },
  plugins: [
    githubReviews({
      enabled: true,
      repositories: [{ name: "owner/repository", skill: "review" }],
    }),
  ],
});

await agent.start();
```

Install and authenticate the GitHub CLI on the host, and provide the configured review skill.

## Docs

- [Run requested GitHub reviews](../../docs/guides/github-reviews.md)
- [Plugins](../../docs/guides/plugins.md)
