# `@picco-agent/plugin-github`

GitHub mention gateway and standalone outbound PR tools for Picco.

## Install

```bash
npm install @picco-agent/core @picco-agent/plugin-github @picco-agent/runtime-local
```

## Usage

```ts
import { readFileSync } from "node:fs";
import { createAgent } from "@picco-agent/core";
import { github } from "@picco-agent/plugin-github";
import { local } from "@picco-agent/runtime-local";

const agent = createAgent({
  name: "assistant",
  runtime: local(),
  plugins: [
    github({
      relayUrl: process.env.GITHUB_RELAY_URL!,
      botUsername: process.env.GITHUB_BOT_USERNAME!,
      appId: process.env.GITHUB_APP_ID!,
      privateKey: readFileSync("./github-app.pem", "utf8"),
    }),
  ],
});
```

For outbound tools without the relay, use `githubTools({ token: getGithubToken })`; see the [standalone PR tools guide](../../docs/guides/plugins.md#use-standalone-github-pr-tools).

## Docs

- [Plugins](../../docs/guides/plugins.md)
