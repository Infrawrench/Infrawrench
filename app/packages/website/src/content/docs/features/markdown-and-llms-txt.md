---
title: Reading the site as markdown
description: Every page on infrawrench.com is available as markdown, for agents and anything else that would rather not parse HTML.
sidebar_order: 13
---

The website answers in markdown as well as HTML. This is for readers that aren't browsers — AI agents, scripts, terminal tools — and it needs no API key.

## Three ways to get it

**Ask for it.** Send an `Accept` header that prefers markdown:

```bash
curl -H 'Accept: text/markdown' https://infrawrench.com/
```

**Append `.md`.** Every page has a markdown twin at the same path:

```bash
curl https://infrawrench.com/index.md
curl https://infrawrench.com/docs/features/agent-auth.md
```

**Start from the index.** `/llms.txt` lists every markdown URL on the site, grouped by section, with a one-line description each:

```bash
curl https://infrawrench.com/llms.txt
```

`robots.txt` points at it too, so a crawler that starts where crawlers start will find it.

## What negotiation does and doesn't cover

Content negotiation works on the home page. Documentation pages are prerendered as static files, so they never reach the code that inspects `Accept` — for those, use the `.md` URL. Each documentation page advertises its own twin in the HTML head:

```html
<link rel="alternate" type="text/markdown" href="/docs/features/agent-auth.md" />
```

The negotiated responses carry `Vary: Accept`, so a shared cache keeps the two representations apart rather than serving whichever it saw first.

A request with no preference gets HTML. That includes `Accept: */*`, which is what most browsers and plain `curl` send — asking for "anything" isn't asking for markdown, and treating it as such would serve plain text to the entire web.

## If you're an agent

The markdown home page leads with how to register for a trial workspace without a human involved. See [agent authentication](./agent-auth.md) for the full story, or fetch [`app.infrawrench.com/auth.md`](https://app.infrawrench.com/auth.md) for instructions written for you rather than about you.

## See also

- [Agent authentication](./agent-auth.md) — registering, and the claim ceremony
- [MCP server](./mcp.md) — the tool-calling endpoint
