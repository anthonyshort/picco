# `@picco-agent/plugin-github-reviews`

Poll personal GitHub review requests and run application reviews from a persistent queue.

## Install

```sh
npm install @picco-agent/core @picco-agent/plugin-github-reviews @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { githubReviews } from "@picco-agent/plugin-github-reviews";
import { local } from "@picco-agent/runtime-local";
import { runReview } from "./review.js";

const agent = createAgent({
  name: "review-assistant",
  runtime: local(),
  plugins: [
    githubReviews({
      runReview,
      enabled: true,
      repositories: [{ name: "owner/repository", skill: "review" }],
    }),
  ],
});

await agent.start();
```

Implement `runReview` in your application. It receives the selected PR and cancellation signal, then returns a review outcome after its worker cleanup finishes. Install and authenticate the GitHub CLI on the host.

## Docs

- [Run requested GitHub reviews](../../docs/guides/github-reviews.md)
- [Address feedback on authored PRs](../../docs/guides/github-feedback.md)
- [Plugins](../../docs/guides/plugins.md)
