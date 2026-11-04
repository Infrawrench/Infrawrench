---
title: Operations calendar
description: See change freezes, sleep windows, expiring certificates and leases, commitment terms, scheduled runs and incidents on one calendar, and subscribe to it from any calendar app.
sidebar_order: 10
---

Your infrastructure already knows a lot of dates. The freeze someone declared for the end of the quarter. The nightly window that stops staging. The certificate that lapses on the 3rd. The reservation whose term ends and puts you back on on-demand pricing. The cron workflow that runs at 02:00. The incident that ran from Tuesday night into Wednesday.

Each of those lives on a different page. **Calendar** puts them all in one place, so you can answer "is anything happening next Tuesday?" just by looking.

Open it from the sidebar.

<insert [The Calendar workspace tab on the month view, showing a week with a change-freeze bar running across several days, a nightly sleep-window chip repeating, and a red certificate deadline] here>

## What's on the calendar

| On the calendar    | Comes from                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Freezes**        | [Change freezes](../team-and-billing/change-freeze.md): the windows when deploys are blocked                |
| **Sleep windows**  | [Sleep schedules](./sleep-schedules.md): when each resource is actually stopped                             |
| **Deadlines**      | [Expiry radar](./expiry-radar.md): certificates, domains, keys, and [resource leases](./resource-leases.md) |
| **Commitments**    | [Commitments](./commitments.md): the day a reservation or savings plan's term ends                          |
| **Scheduled runs** | [Workflows](./workflows.md) with a cron trigger                                                             |
| **Incidents**      | [Incident mode](./incident-mode.md): declared incidents, from start to resolution                           |

The calendar is always up to date with those sources. End a freeze early and it stops on the calendar at the moment you ended it.

Spans show as bars. Deadlines show as all-day markers. A freeze with no end, or an incident that's still open, runs to the edge of the view.

## Filter and switch views

The chips along the top turn each source on and off. A source with nothing in the current window tells you so.

- **Month:** the grid. Click a day to see everything on it.
- **Agenda:** the same events as a list, soonest first.

Click an event to open what it came from. A sleep window opens its resource, a deadline opens the resource or the expiry radar, and an incident opens Incidents.

If one source can't be loaded, the calendar tells you which one and still shows everything else.

## Subscribe from your calendar app

The **Subscriptions** tab creates a URL you can paste into Google Calendar, Outlook, Apple Calendar or your phone. It refreshes on its own, roughly every hour.

<insert [The Subscriptions tab with one live subscription listed and the one-time URL panel visible after creating it] here>

When you create a feed, choose which kinds of events it includes. Choosing nothing means everything, including kinds added to Infrawrench later. That's usually what you want for a team calendar.

**Treat the URL like a password.** Anyone with the link can read the feed without signing in.

- The URL is shown **once**, when you create it. If you lose it, revoke the feed and create another.
- The feed only includes names, times and kinds. No credentials, costs, resource ids or organization id, so a leaked feed exposes your schedule and nothing anyone could act on.

Revoking stops a URL immediately. The feed stays in the list for your audit trail, and you can see when each one was last fetched before deciding whether anyone still uses it.

Creating and revoking subscriptions needs **Organization settings: write**. Viewing the calendar needs only **Resources: read**.

## Limits

- A window can span at most 400 days. The default view loads the six weeks the month grid shows.
- Recurring items (sleep windows, cron runs) show at most 400 occurrences each.
- An organization can have 25 live subscriptions. Revoke one to make room.

## Use the API

`GET /api/org/{orgId}/calendar?from=…&to=…&kinds=…` returns the same events the page shows. See the [OpenAPI reference](../team-and-billing/openapi.md).
