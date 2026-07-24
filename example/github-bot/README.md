# GitHub bot

A GitHub App that responds to issue and pull-request mentions received through a WebSocket relay.
Each mention runs in an isolated bubblewrap session against a local llama.cpp model.

## Prerequisites

- Linux with Node.js 22 or newer, pnpm, bubblewrap 0.8 or newer, and `pi` 0.80 or newer on `PATH`.
- An OpenAI-compatible model server at `http://127.0.0.1:8080/v1` serving
  `qwen-27b-q6-turbo`.
- A GitHub App private key and a compatible WebSocket relay.

## Configure

From this directory:

```bash
cp .env.example .env
```

Fill in the relay URL, bot username, GitHub App ID, and private-key path. Relative private-key paths
resolve from `src/`.

## Run

```bash
pnpm start
```

Mention the configured bot in an issue or pull request to create a scoped agent session.
