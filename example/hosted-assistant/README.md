# Hosted assistant

A minimal Telegram assistant using Claude through the Anthropic API. Only the Anthropic API key is
forwarded into its bubblewrap sessions.

## Prerequisites

- Linux with Node.js 22 or newer, pnpm, bubblewrap 0.8 or newer, and `pi` 0.80 or newer on `PATH`.
- A Telegram bot token and Anthropic API key.

## Configure

From this directory:

```bash
cp .env.example .env
```

Fill in the bot token, comma-separated numeric Telegram chat IDs, and Anthropic API key.

## Run

```bash
pnpm start
```

Send the bot a message from an allowlisted chat to create an isolated session.
