# `@picco-agent/plugin-browser-checks`

Answer a concrete browser question through an existing Atlas tester workflow.

## Install

```sh
npm install @picco-agent/core @picco-agent/plugin-browser-checks @picco-agent/runtime-local
```

## Usage

```ts
import { createAgent } from "@picco-agent/core";
import { browserChecks } from "@picco-agent/plugin-browser-checks";
import { local } from "@picco-agent/runtime-local";

const browser = browserChecks({
  atlas: {
    url: process.env.ATLAS_URL!,
    token: process.env.ATLAS_TOKEN!,
    workflow: "browser-tester",
  },
  profiles: {
    preview: {
      origins: ["https://preview.example.test"],
      instructions: "Use the configured Atlas identity and disposable test fixture.",
    },
  },
  onUpdate: async (job) => {
    console.log(job.id, job.version, job.state);
  },
});

const agent = createAgent({
  name: "browser-pilot",
  runtime: local(),
  plugins: [browser],
});
await agent.start();

const job = browser.checks.start({
  requestKey: "filter-question-1",
  profile: "preview",
  url: "https://preview.example.test/invoices",
  question: "Does filtering by paid status update the rows and total?",
  expected: "Only paid invoices remain and the count matches the displayed results.",
});
console.log(browser.checks.status(job.id));
```

Provide Atlas access and an authenticated Pi model before starting. This local-runtime example is for a controlled pilot without unrelated credentials; use a scoped sandbox before adding it to an application.

## Docs

- [Run bounded browser checks](../../docs/guides/browser-checks.md)
- [Plugins](../../docs/guides/plugins.md)
