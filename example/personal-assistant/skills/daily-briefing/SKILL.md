---
name: daily-briefing
description: Compose a short morning briefing — weather, anything due today, and one interesting thing. Use when asked for a briefing, a morning summary, or "catch me up".
---

# Daily briefing

Compose a briefing with three short sections, in this order:

1. **Weather** — use web_search (or fetch wttr.in) for the current conditions
   and today's range where the user is. One line.
2. **On the plate** — check memory and any active cron jobs for things the
   user said they're doing or waiting on. Skip the section if there's nothing.
3. **One interesting thing** — a single item from a web search on a topic the
   user's memory says they care about. Link it.

Keep the whole thing under 120 words. No headers in the output — just three
tight paragraphs. Don't invent calendar events; only report what you can
actually see.
