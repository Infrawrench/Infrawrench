---
title: Expiry radar
description: One countdown across all your providers for everything that expires (TLS certificates, domain registrations, API tokens, database passwords, secret rotation age), with alerts before anything runs out.
sidebar_order: 10
---

Certificates expire, domains lapse, tokens run out, and the secret nobody rotated keeps getting older. Each has its own clock in its own provider console. The expiry radar puts them all in one countdown: everything in your organization with a deadline, soonest first, with alerts before anything runs out.

It costs nothing to leave on. The radar uses data your accounts already sync, so it makes no extra provider API calls and doesn't count against your rate limits. It covers every provider that reports a deadline.

## What it tracks

There are two kinds of deadline:

- **Fixed expiry dates:** ACM, Cloudflare, Google Cloud, Fly.io, DigitalOcean and Hetzner TLS certificates; Vercel domain registrations; API keys and credentials with expiration dates (Anthropic, OpenAI project keys, OpenRouter, xAI, Fireworks, Mistral, Deepgram, ClickHouse Cloud, Grafana Cloud access policy tokens, WorkOS organization keys, Tailscale auth keys and OAuth clients, Neon, PlanetScale database passwords); Tailscale device node keys (devices with key expiry turned off are skipped); Neon branch expiry; Anthropic Files API uploads; pending invites; backups and snapshots with retention deadlines; BigQuery tables with an expiration set.
- **Age limits:** the deadline comes from when something was created or last rotated. An AWS Secrets Manager secret not rotated in 90 days, an OpenAI project API key older than 180 days, or a Twilio API key past its rotation window is due for rotation.

Every item falls into a severity group:

- **Expired**
- **Critical:** within 7 days
- **Warning:** within 30 days
- **Upcoming:** within your organization's lead time (60 days by default)

Items further out than the lead time are still listed, so you see the full countdown, not just the alarms.

## The Expiring screen

Web, desktop and mobile all have an **Expiring** screen. Severity totals sit at the top, then the list, grouped by kind (TLS certificates, domains, API tokens, secret versions and so on), by account, or by severity. Each row names the resource, what exactly expires and how long is left. Click the resource name (or use the keyboard) to open the resource and renew, rotate or delete it.

![Web Expiring screen showing the severity summary (expired / 7d / 30d / lead-time counts) and the feed grouped by kind, with a TLS certificate at "in 5d" marked critical](https://agent-assets.infrawrench.com/docs-screenshots/features/expiry-radar/expiring-screen.png)

On desktop it works in both modes. Signed into Infrawrench Cloud, it shows the whole organization. In local-only mode, it shows the countdown for the workspace on your machine.

<insert [Mobile Expiring screen with severity chips and grouped rows, one domain registration showing "in 21d"] here>

## Get alerts before something expires

Clusters and databases nearing the end of their provider's standard support also show up here, as **Extended support** deadlines: the day a surcharge starts, or the day the provider upgrades the resource. For the cost side, see [Extended support findings](./extended-support.md).

When items fall inside your lead time, Infrawrench sends one summary alert with counts per severity and the soonest deadlines. It goes to the same places as your other alerts: Slack channels, Microsoft Teams webhooks and mobile push.

- The **Expiry alerts** trigger is on by default. Turn it on or off per channel and per user in **Settings > Notifications** (or on the mobile notifications screen).
- You get at most one alert per organization per day, so a certificate three weeks out reminds you daily.

![Org settings showing the Expiry radar card with the enabled toggle and lead-time input set to 60 days](https://agent-assets.infrawrench.com/docs-screenshots/features/expiry-radar/settings-card.png)

### Set the lead time

The lead time decides where the "upcoming" group ends on the screen and how early alerts start. Set it per organization in the same settings card. Try 30 days if you only want near-term reminders, or 90 if your renewals need time for procurement.

**The weekly digest** adds an "Expiring soon" line whenever deadlines fall within your lead time, so even with alerts muted you hear about it once a week.

## The CLI

`infrawrench expiring` prints the same list, soonest first. Add `--json` for scripts, or `--local` for the desktop workspace on your machine:

```
$ infrawrench expiring
Acme Corp · 14 deadlines · 1 expired · 2 within 7d

resource            type              account   deadline              due          remaining
api.acme.com        ACM Certificate   Prod AWS  Certificate expires   2026-08-04   in 3d
acme-corp.dev       Domain            Vercel    Registration expires  2026-08-20   in 19d
prod-db-password    Password          Planet    Password expires      2026-09-02   in 32d
```

## MCP

The `list_expiring` tool gives AI agents the same list, filterable by severity and kind. An agent asked "is anything about to break?" can answer with your real deadlines, and an agent automating renewals knows what to renew first.

## Limitations

- The radar only sees expiry dates your providers report. Azure app registration client-secret expiries and AWS IAM access-key ages aren't tracked yet.
- Age limits are conventions, not provider rules. The 90-day secret rotation window is a default, and an "expired" age item means "older than the limit", not "stopped working".
- Missing or unreadable dates are skipped, never alerted on. A BigQuery table whose expiration is "NEVER" stays off the radar.

See also: [Orphan finder](./orphan-finder.md), [Slack alerts](./slack-alerts.md), [Teams alerts](./teams-alerts.md), [Mobile push notifications](./mobile-push-notifications.md), [Weekly digest](./weekly-digest.md), [CLI](./cli.md), [MCP](./mcp.md).
