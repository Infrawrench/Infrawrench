---
title: Provider status correlation
description: Infrawrench watches your providers' public status pages and tells you when an upstream incident overlaps resources you actually hold. Is it me, or is it them?
sidebar_order: 9
---

When something starts failing, the first question is always the same: is it your change, or is your provider having a bad day? Infrawrench helps you answer that. It watches the public status feeds of AWS, Google Cloud, Cloudflare, DigitalOcean, Fly.io, Neon, Azure, Hetzner, Scaleway, Crusoe Cloud, Netlify, Vercel, PlanetScale, ClickHouse Cloud, Redis Cloud, OpenAI, Anthropic, Groq, Replicate, Modal, Cursor and Baseten, and checks active incidents against the resources your organization holds.

So instead of "DigitalOcean has an incident somewhere", you see **"DigitalOcean NYC3 degraded: 12 of your resources there"**.

Status feeds are public. No credentials are used, nothing counts against your provider API rate limits, and providers without a machine-readable status page aren't included.

## Where you'll see it

**A banner across the app.** When an active incident overlaps your resources, a banner appears at the top of the web, desktop and mobile apps. It names the provider, the affected regions or services, and how many of your resources are affected, with a link to the provider's status page. Dismiss it and it stays hidden for that session. It never appears when nothing of yours is affected.

![Web app with the provider incident banner visible at the top: "DigitalOcean nyc3 degraded: 12 of your resources there", with the "Provider status" link on the right](https://agent-assets.infrawrench.com/docs-screenshots/features/provider-status/incident-banner.png)

**The Changes page.** Provider incidents (active, or resolved in the last day) appear above the change timeline, each with a count of the changes recorded during the incident. If you see a burst of resources flapping, you can tell at a glance whether it lined up with an upstream incident.

![Changes page showing the "Is it you, or is it them?" section above the drift feed, with an incident row reading "5 changes during this incident"](https://agent-assets.infrawrench.com/docs-screenshots/features/provider-status/changes-is-it-them.png)

**Notifications.** The **Provider incidents** trigger sends to Slack channels, Microsoft Teams webhooks and mobile push, like other alerts. It's on by default. Turn it on or off per channel and per user in **Settings > Notifications** (or on the mobile notifications screen). You get one notification per incident per organization, with no repeats as it evolves. Provider incidents never page by SMS or voice, since your on-call can't fix an upstream outage.

![Notification settings page showing the "Provider incidents" toggle among the alert triggers for a Slack channel](https://agent-assets.infrawrench.com/docs-screenshots/features/provider-status/provider-incidents-trigger.png)

**The weekly digest** includes a "Provider incidents" line counting upstream incidents that overlapped your providers that week.

**The CLI.** `infrawrench incidents` lists everything the banner knows. Add `--json` for scripts:

```
$ infrawrench incidents
Acme Corp · 1 active provider incident, 0 resolved in the last 24h

impact  provider      incident                          scope  your resources  changes during  since
major   DigitalOcean  Elevated Droplet create errors    nyc3   12              5               2h ago
```

**MCP.** The `list_provider_incidents` tool gives AI agents the same information, so an agent debugging a failure can check whether the provider is at fault before touching anything.

## How incidents are matched to your resources

An incident counts as affecting a resource when:

- the incident is **provider-wide** (a global API outage, for example),
- it names the resource's **region**, including the zones inside it (an incident in `us-central1` matches a resource in zone `us-central1-a`), or
- it names the resource's **type** (a Cloudflare Workers incident matches your Workers, not your DNS zones).

Incidents that don't touch anything you hold stay quiet. An edge reroute on another continent won't ping you.

## Limits

- Matching is only as precise as the provider's status page. Some providers (Azure and Redis feeds, most AI providers) don't say which regions are affected, so their incidents are treated as provider-wide.
- "N changes during this incident" is a hint, not proof of cause. It counts every change on that provider during the incident window.
- This needs the cloud. The desktop app in local-only mode has no incident data to show.

This isn't the same as [incident mode](./incident-mode.md), which covers incidents **your organization declares**. This page is about someone else's outage. The two meet on a declared incident's timeline, where an overlapping provider incident shows up as evidence.

See also: [Incident mode](./incident-mode.md), [Change timeline](./change-timeline.md), [Slack alerts](./slack-alerts.md), [Teams alerts](./teams-alerts.md), [Mobile push notifications](./mobile-push-notifications.md), [Weekly digest](./weekly-digest.md).
