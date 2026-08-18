---
title: Operations calendar
description: Every dated thing your infrastructure already knows about, on one axis — change freezes, sleep windows, expiring certificates and leases, commitment terms, scheduled runs and incidents. Subscribe to it from any calendar app.
sidebar_order: 10
---

Your infrastructure already knows a dozen dates. The freeze someone declared
for the end of the quarter. The nightly window that stops staging. The
certificate that lapses on the 3rd. The reservation whose term ends and quietly
puts you back on on-demand pricing. The cron workflow that runs at 02:00. The
incident that ran from Tuesday night into Wednesday.

Every one of those lives on a different page. **Calendar** is the one axis they
share, so "is anything happening next Tuesday?" becomes a question you can
answer by looking.

Open it from the sidebar.

<insert [The Calendar workspace tab on the month view, showing a week with a change-freeze bar running across several days, a nightly sleep-window chip repeating, and a red certificate deadline] here>

## What it shows

Six sources, each already recorded elsewhere:

| On the calendar    | Comes from                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Freezes**        | [Change freezes](../team-and-billing/change-freeze.md) — the windows that make a deploy refuse               |
| **Sleep windows**  | [Sleep schedules](./sleep-schedules.md) — when each resource is actually stopped                             |
| **Deadlines**      | [Expiry radar](./expiry-radar.md) — certificates, domains, keys, and [resource leases](./resource-leases.md) |
| **Commitments**    | [Commitments](./commitments.md) — the day a reservation or savings plan's term ends                          |
| **Scheduled runs** | [Workflows](./workflows.md) with a cron trigger                                                              |
| **Incidents**      | [Incident mode](./incident-mode.md) — declared incidents, from start to resolution                           |

Nothing here is a new record. The calendar is a projection recomputed every
time you open it, so there is nothing to keep in step and nothing that can go
stale: end a freeze early and it stops on the calendar at the moment you ended
it, not at the date it was declared to run to.

Spans draw as bars and deadlines draw as all-day markers, because a certificate
expiry read off a date field is a _day_ — showing it at whatever midnight the
provider happened to store would be false precision.

A freeze with no end, or an incident that is still open, runs to the edge of
the view rather than stopping at an invented end.

## Filters and views

The chips along the top turn each source on and off; a source with nothing in
the window says so rather than looking broken.

- **Month** — the grid. Click a day to see everything on it.
- **Agenda** — the same events as a flat list, soonest first.

Clicking an event opens the thing it came from: a sleep window opens its
resource, a deadline opens the resource or the expiry radar, an incident opens
Incidents.

If one source cannot be read, the calendar says which and shows everything
else. A summary page that silently drops a source is worse than one that admits
it.

## Subscribing from a calendar app

The **Subscriptions** tab mints a URL you can paste into Google Calendar,
Outlook, Apple Calendar or your phone. It refreshes on its own, roughly hourly.

<insert [The Subscriptions tab with one live subscription listed and the one-time URL panel visible after creating it] here>

Choose which kinds the feed carries when you create it. Selecting nothing means
everything — including kinds added to Infrawrench later, which is usually what
you want for a team calendar.

**Treat the URL as a password.** It runs outside every sign-in, because a
calendar client cannot hold a session — the random token in the URL is the only
credential. Two things follow:

- The URL is shown **once**, when you create it. There is no way to read it
  again; if you lose it, revoke the feed and mint another.
- The feed carries names, times and kinds only. No credentials, no costs, no
  resource ids, and no organization id — so a leaked feed exposes your
  schedule and nothing you could act on.

Revoking stops a URL immediately. The row stays in the list so the audit trail
still resolves, and you can see when each feed was last fetched before deciding
whether anyone still needs it.

Creating and revoking subscriptions needs **Organization settings: write**;
reading the calendar itself needs only **Resources: read**.

## Limits

- A window may span at most 400 days. The default view fetches the six weeks
  the month grid draws.
- Recurring sources (sleep windows, cron runs) are expanded to at most 400
  occurrences each, so one nightly schedule cannot flood a long query.
- An organization may hold 25 live subscriptions. Revoking makes room.

## Over the API

`GET /api/org/{orgId}/calendar?from=…&to=…&kinds=…` returns the same events the
page draws. See the [OpenAPI reference](../team-and-billing/openapi.md).
