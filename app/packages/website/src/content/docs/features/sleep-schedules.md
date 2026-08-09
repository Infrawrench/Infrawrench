---
title: Sleep/wake schedules
description: Stop non-prod resources outside working hours and start them back automatically — off at 19:00, on at 08:00, Mon–Fri — with a projected monthly saving quoted before you save.
sidebar_order: 11
---

A staging database that runs nights and weekends costs the same as one that doesn't — it just does nothing for two-thirds of the week. A sleep/wake schedule is a no-code weekly window attached to a resource: Infrawrench stops it at the off time and starts it at the on time on the days you pick, in the timezone you pick, and quotes the projected monthly saving before you commit.

## Which resources can sleep

Eligibility is discovered from each provider plugin, never hard-coded: a resource can carry a schedule when its type declares a lifecycle start/stop action pair. Out of the box that covers:

- **AWS** — EC2 instances, RDS instances
- **Google Cloud** — Compute Engine VM instances
- **Azure** — Virtual machines (stop = deallocate, the one that stops billing)
- **DigitalOcean** — Droplets
- **Hetzner Cloud** — Servers
- **Scaleway** — Instances
- **Fly.io** — Machines
- **Neon** — Compute endpoints (stop = suspend; note any incoming connection also wakes a suspended endpoint)
- **Together AI** — Dedicated inference endpoints
- **ClickHouse Cloud** — Services

The same start/stop actions appear as buttons on each resource's detail page, so you can always override a schedule by hand.

Note that a stopped resource isn't always a free resource: DigitalOcean and Hetzner keep billing stopped servers, and disks/IPs attached to a stopped VM keep billing everywhere. The projected saving is an estimate from your actual trailing spend, not a promise.

## Creating a schedule

Open an eligible resource and switch to its **Schedule** tab. Pick the working days, the off time, the on time, and the IANA timezone — the editor previews the next few transitions so you can sanity-check the zone, and quotes the projected monthly saving computed from the resource's trailing 30-day spend and the fraction of the week it would be off.

![Screenshot of the Schedule tab on an EC2 instance's detail page showing the editor modal with Mon–Fri selected, off 19:00 / on 08:00, Europe/London, and the projected monthly saving quote](https://agent-assets.infrawrench.com/docs/screenshots/features/sleep-schedule-editor.png)

One schedule per resource. Times are wall-clock in the chosen zone and stay correct across daylight-saving transitions.

## Managing schedules

The **Sleep schedules** section of the Costs panel lists every schedule in the org — the window, the next transition, the last run's outcome, and the projected saving — with pause/resume, edit, and delete controls.

![Screenshot of the Sleep schedules section on the Costs panel with several schedules listed, one paused and one showing a "Skipped: freeze" badge](https://agent-assets.infrawrench.com/docs/screenshots/features/sleep-schedules.png)

Creating, editing, and deleting a schedule are recorded in the [audit log](../team-and-billing/audit-log.md).

## How execution works

The cloud poller executes due transitions server-side by invoking the plugin's own start/stop action — no agent on the resource, nothing to install. A few behaviors worth knowing:

- **Change freezes win.** While an [org change freeze](../team-and-billing/change-freeze.md) is in effect, transitions are skipped, logged, and surfaced on the schedule as "Skipped: freeze" — they do not fire late when the freeze lifts.
- **Transitions appear in the change timeline** attributed to the schedule ("via schedule"), so a stopped staging VM never reads as unexplained drift in the [change timeline](./change-timeline.md).
- **Failures are visible.** A failed start/stop is retried for up to an hour and the last error is shown on the schedule everywhere schedules are listed — a schedule never fails silently.
- **Missed windows resolve to the latest state.** If execution was interrupted for longer than a window, only the most recent transition runs — the one that decides whether the resource should currently be up or down.

## Other surfaces

- **Mobile** shows the schedule list on the Costs tab with a pause/resume toggle; creating and editing stays on web and desktop.
- **CLI**: `infrawrench schedules` lists windows, next transitions, and projected savings (`--json` for scripts).
- **MCP**: the `list_schedules` and `create_schedule` tools let agents read and create schedules under the same permissions as the UI.

## Permissions

Viewing schedules needs `resources:read`. Creating, editing, pausing, and deleting need `resources:write` — the same permission that gates invoking a resource's actions directly.
