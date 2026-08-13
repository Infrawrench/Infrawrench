---
title: Provider status correlation
description: Infrawrench watches your providers' public status pages and tells you when an upstream incident overlaps resources you actually hold — is it me, or is it them?
sidebar_order: 9
---

When something starts failing, the first question is always the same: is it your change, or is your provider having a bad day? Infrawrench answers it for you. The cloud poller watches the public status feed of every provider that publishes one — AWS, Google Cloud, Cloudflare, DigitalOcean, Fly.io, Neon, Azure, Hetzner, Scaleway, Netlify, Vercel, PlanetScale, ClickHouse Cloud, OpenAI, Anthropic, Groq, Replicate — and correlates active incidents against the resources your organization holds.

The result isn't "DigitalOcean has an incident somewhere". It's **"DigitalOcean NYC3 degraded — 12 of your resources there"**.

Status feeds are public: no credentials are involved, nothing counts against your provider API rate limits, and providers without a machine-readable status page simply don't participate.

## Where it shows up

**A banner across the app.** When an active incident overlaps your resources, a banner appears at the top of the web app, the desktop app, and the mobile app. It names the provider, the affected regions or services, and how many of your resources sit in the blast radius, with a link to the provider's own status page. Dismiss it and it stays gone for that session; it never appears when nothing overlaps you.

<insert [Web app with the provider incident banner visible at the top: "DigitalOcean nyc3 degraded — 12 of your resources there", with the "Provider status" link on the right] here>

**The Changes page.** Provider incidents (active, or resolved within the last day) render above the change timeline, each annotated with how many recorded changes happened during the incident's window — so when the drift feed shows a burst of resources flapping, you can see at a glance that it coincided with an upstream incident rather than something you did.

<insert [Changes page showing the "Is it you, or is it them?" section above the drift feed, with an incident row reading "5 changes during this incident"] here>

**Notifications.** A new **Provider incidents** trigger fans out over the same transports as the other alerts — Slack channels, Microsoft Teams webhooks, and mobile push. It's on by default and can be toggled per channel and per user in **Settings → Notifications** (and on the mobile notifications screen). One notification per incident per organization — no repeats as the incident evolves. Provider incidents deliberately never page SMS or voice: an upstream outage isn't something your on-call can fix.

![Notification settings page showing the "Provider incidents" toggle among the alert triggers for a Slack channel](https://agent-assets.infrawrench.com/docs-screenshots/features/provider-status/provider-incidents-trigger.png)

**The weekly digest** gains a "Provider incidents" line counting the upstream incidents that overlapped your providers during the reported week.

**The CLI.** `infrawrench incidents` lists everything the banner knows, with `--json` for scripts:

```
$ infrawrench incidents
Acme Corp · 1 active provider incident, 0 resolved in the last 24h

impact  provider      incident                          scope  your resources  changes during  since
major   DigitalOcean  Elevated Droplet create errors    nyc3   12              5               2h ago
```

**MCP.** The `list_provider_incidents` tool exposes the same correlation to AI agents, so an agent debugging a failure can check whether the provider is the culprit before touching anything.

## How matching works

Each provider plugin declares its status feed and ships a mapper from the feed's components to its own region and resource-type identifiers. An incident matches a resource when any of these hold:

- the incident is **provider-wide** (a global API outage, say),
- it names the resource's **region** — including hierarchical matches, so an incident in `us-central1` matches a resource in zone `us-central1-a`,
- it names the resource's **type** (a Cloudflare Workers incident matches your Workers, not your DNS zones).

Incidents that match nothing you hold are still cached but stay quiet — an edge-PoP reroute on another continent won't ping you.

## Caveats

- Correlation is only as precise as the provider's status page. Some providers (Azure's RSS feed, most AI providers) don't scope incidents to regions, so their incidents are treated as provider-wide.
- "N changes during this incident" is a correlation hint, not a causal claim — the count covers all changes on that provider during the incident window.
- The feature is cloud-only: the poller fills the incident cache, so the desktop app in local-only mode has nothing to correlate.

Not to be confused with [incident mode](./incident-mode.md), which is about incidents **your
organization declares**. This page is about somebody else's outage. The two meet on a declared
incident's timeline, where an overlapping provider incident appears as evidence.

See also: [Incident mode](./incident-mode.md), [Change timeline](./change-timeline.md), [Slack alerts](./slack-alerts.md), [Teams alerts](./teams-alerts.md), [Mobile push notifications](./mobile-push-notifications.md), [Weekly digest](./weekly-digest.md).
