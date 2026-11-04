---
title: Investigate a moment
description: Enter a timestamp and see everything that happened around it in one timeline, including changes, incidents, cost anomalies, workflow runs, deployments, audit entries and freezes.
sidebar_order: 10
---

Something broke around 03:14. The change timeline knows a droplet resized, the status feed knows DigitalOcean was having a bad night, the deploy log knows someone shipped at 03:02, and the audit log knows who. Normally that means five tabs and a lot of squinting at timestamps.

The moment view answers the real question: **"what changed around 03:14?"** Enter a timestamp, pick a window (±15m, ±1h or ±6h), and you get one timeline of everything Infrawrench knows happened in that window.

## What's in the timeline

- **Resource changes:** anything that appeared, changed or disappeared, including scheduled stops and starts marked "via sleep/wake schedule". See [Change timeline](./change-timeline.md).
- **Provider status incidents:** incidents that started, resolved or were ongoing in the window. See [Provider status](./provider-status.md).
- **Cost anomalies:** spikes and new spend sources, by when they were detected. See [Cloud costs](./cloud-costs.md).
- **Workflow runs:** starts, successes, failures and cancellations. See [Workflows](./workflows.md).
- **Deployments:** deploy starts and finishes, with failures marked. See [Infrafile](./infrafile.md).
- **Audit log entries:** who created, updated, deleted, froze or unfroze what. See [Audit log](../team-and-billing/audit-log.md).
- **Change freezes:** freezes that started or ended in the window. See [Change freezes](../team-and-billing/change-freeze.md).
- **Drift and expiry alerts:** when your drift digest or [expiry radar](./expiry-radar.md) alert went out. Only the most recent delivery of each is kept, so each adds at most one event.

Every event has a severity, and each row links to where it lives: the resource, the workflow, the deploy log or the provider's incident page.

![Web moment view for a timestamp with the window preset row (±15m/±1h/±6h), a mixed timeline showing a deploy failure in red, resource changes, and an incident-started event](https://agent-assets.infrawrench.com/docs-screenshots/features/moment/moment-window.png)

## Spot provider incidents and bursts

When a provider incident overlaps your window, every event during it gets a **"during DigitalOcean incident"** badge, so you can see what might be them and not you. Bursts of changes to the same resource within minutes collapse into one expandable group, so a flapping machine shows as one line instead of thirty.

![Moment timeline with three change events badged "during DigitalOcean incident" and a collapsed burst row reading "5 events on api-prod-1"](https://agent-assets.infrawrench.com/docs-screenshots/features/moment/incident-badges-burst.png)

## Permissions and missing sources

You only see sources your role can read. If you can't read the audit log, for example, the timeline marks that source as **omitted** so you know it's missing. If one source fails to load, the rest still shows, with a chip such as "Workflow runs unavailable".

## Open the moment view

- **From the Changes page:** click **Investigate a moment** on web, desktop or mobile.
- **From a link:** the timestamp and window are in the URL (`/org/…/moment?at=2026-08-03T03:14:00Z&window=60`), so you can share a moment, and alerts can link straight to it.
- **From a push notification:** cost anomaly, drift and provider incident pushes on mobile open the moment view centred on their time.

<insert [Mobile moment screen opened from a drift push, showing the window chips and a merged timeline with an incident notice at the top] here>

## Use the CLI

`infrawrench moment [timestamp]` prints the same timeline in your terminal. Leave out the timestamp for "around now", change the window with `--window`, and use `--json` for scripts:

```
$ infrawrench moment 2026-08-03T03:14 --window 1h
Acme Corp · 2026-08-03 02:14:00 → 2026-08-03 04:14:00 UTC (±60m around 2026-08-03 03:14:00)

Provider incidents overlapping this window
  ▲ DigitalOcean: API errors in NYC3 (active) https://status.digitalocean.com/…

  03:02:11 · [Deployments] Deploy started: acme/api@f3a91c2 → prod
  03:05:40 ✗ [Deployments] Deploy failed: acme/api@f3a91c2 → prod
  03:08:19 · [Resource changes] api-prod-1 changed: size (during DigitalOcean incident)
  03:14:02 ! [Cost anomalies] Cost spike detected: DigitalOcean
```

## Use it from an AI agent

The `what_changed` MCP tool takes a timestamp and a window and returns the events and the status of each source. An agent asked "why did the site go down at 03:14?" can pull the whole picture in one call, with the same permissions you have on screen. See [MCP](./mcp.md).

## Limits

- You can only look back as far as each source keeps data. Resource changes are kept for 90 days, so a moment from last quarter will look thinner.
- Drift and expiry alerts only keep their most recent send, so older windows won't show them.
- Incident badges show timing, not cause. They tell you where to look, not what went wrong.

See also: [Incident mode](./incident-mode.md) (a declared incident's timeline is built the same way), [Change timeline](./change-timeline.md), [Provider status](./provider-status.md), [Cloud costs](./cloud-costs.md), [Audit log](../team-and-billing/audit-log.md), [CLI](./cli.md), [MCP](./mcp.md).
