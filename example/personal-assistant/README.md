# Personal assistant

A local-model assistant with Telegram, scheduled jobs, email, persistent memory, and per-user
connections to hosted tools.

The example includes:

- Telegram conversations and the `/connect`, `/connections`, and `/disconnect` commands.
- Linear, Notion, GitHub, Gmail, and Google Calendar connectors.
- Cron and AgentMail host plugins.
- A bubblewrap sandbox with shared Hermes memory and a custom research subagent.
- Context Mode, Hermes Memory, Pi Subagents, Pi Tasks, RPIV Advisor, and pi-searxng.

## Prerequisites

- Linux with Node.js 22 or newer, pnpm, bubblewrap 0.8 or newer, and `pi` 0.80 or newer on `PATH`.
- An OpenAI-compatible local model server at `http://127.0.0.1:8080/v1` serving
  `qwen-27b-q6-turbo`.
- A Telegram bot, an AgentMail inbox, GitHub OAuth credentials, and Google OAuth credentials.
- A SearXNG server if one is not already running at `http://localhost:8080`.

## Configure

From this directory:

```bash
cp .env.example .env
openssl rand -hex 32
```

Put the generated key in `CONNECTIONS_KEY`, then fill in the remaining required values. Telegram
allowlists use numeric chat IDs; separate multiple IDs with commas.

Linear and Notion use OAuth discovery and need no application credentials. GitHub needs an OAuth
app client ID and secret. Register this callback URL when using the default paste-back flow:

```text
http://127.0.0.1:8976/oauth/callback
```

For Gmail and Google Calendar:

1. Join the Google Workspace Developer Preview Program.
2. Enable the Gmail API, Google Calendar API, Gmail MCP API, and Google Calendar MCP API.
3. Add the Gmail and Calendar scopes listed in `src/index.ts` to the OAuth consent screen.
4. Create a Web application OAuth client and register the callback URL above.

Set `CONNECTIONS_CALLBACK_URL` only when a public URL forwards to
`http://127.0.0.1:8976` with the same `/oauth/callback` path. Register that public URL with GitHub
and Google instead of the loopback URL.

## Run

```bash
pnpm start
```

The first session downloads the pinned Pi packages. Send the bot a direct message, then list or
connect services:

```text
/connect
/connect linear
/connect notion
/connect github
/connect gmail
/connect google-calendar
/connections
```

With paste-back authentication, the browser may fail to load the loopback callback. Copy its full
URL from the address bar and send it to the bot as `/connect <name> <url>`. OAuth links and callback
URLs should stay in a direct message, not a group chat.

After connecting, ask the assistant to list an issue, search a Notion workspace, summarize recent
email, or show upcoming calendar events. Connector credentials remain in the host process and are
stored encrypted under `~/.picco/assistant/connections`; Hermes memory persists under
`~/.picco/assistant/shared`.

Scheduled jobs are YAML files in `cron/`. The sample weather job in `cron/weather.yaml` is
disabled — set a real recipient and `enabled: true` to use it. Ask the assistant to schedule
something with the `cron_*` tools, or add job files by hand; hand-written jobs stay local (the
directory is gitignored apart from the sample, since job files tend to carry personal prompts and
recipients).

Provider setup references: [Linear MCP](https://linear.app/docs/mcp),
[Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp),
[GitHub OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app),
and [Google Workspace MCP](https://developers.google.com/workspace/guides/configure-mcp-servers).
