---
title: Reading the site as markdown
description: Every page on infrawrench.com is available as markdown, for agents and anything else that would rather not parse HTML.
sidebar_order: 13
---

You can read any page on infrawrench.com as markdown instead of HTML. This is handy for AI agents, scripts and terminal tools, and it needs no API key.

## Get a page as markdown

There are three ways.

**Ask for it.** Send an `Accept` header that prefers markdown:

```bash
curl -H 'Accept: text/markdown' https://infrawrench.com/
```

**Add `.md` to the path.** Every page has a markdown version at the same address:

```bash
curl https://infrawrench.com/index.md
curl https://infrawrench.com/docs/features/agent-auth.md
```

**Start from the index.** `/llms.txt` lists every markdown URL on the site, grouped by section, with a one-line description for each:

```bash
curl https://infrawrench.com/llms.txt
```

`robots.txt` links to it as well, so crawlers can find it.

## How the Accept header is read

The home page and every documentation page respond to your `Accept` header.

You get markdown when you weight it above HTML:

```bash
curl -H 'Accept: text/markdown;q=1.0, text/html;q=0.1' https://infrawrench.com/
```

You also get markdown when you list it first with no weights, which is how most HTTP clients express a preference:

```bash
curl -H 'Accept: text/markdown, text/html, */*' https://infrawrench.com/
```

Weights (`q`) are checked first. If markdown and HTML have the same weight, whichever you list first wins. `text/plain` and `text/x-markdown` both count as markdown.

If you don't state a preference, you get HTML. That includes `Accept: */*`, which most browsers and plain `curl` send. Browsers never ask for markdown, so they always get HTML.

## Find the markdown link from a page

If you'd rather follow a link than set a header, every page points to its markdown version in a response header:

```
Link: <https://infrawrench.com/index.md>; rel="alternate"; type="text/markdown"
```

and in the HTML head:

```html
<link rel="alternate" type="text/markdown" href="/docs/features/agent-auth.md" />
```

Responses also include `Vary: Accept`, so shared caches keep the markdown and HTML versions separate.

## If you're an agent

The markdown home page starts with how to register for a trial workspace without a human. See [agent authentication](./agent-auth.md) for the details, or fetch [`app.infrawrench.com/auth.md`](https://app.infrawrench.com/auth.md) for instructions written for you.

## See also

- [Agent authentication](./agent-auth.md): registering, and claiming the workspace
- [MCP server](./mcp.md): the tool-calling endpoint
