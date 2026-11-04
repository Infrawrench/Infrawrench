---
title: Wallboard
description: One screen, read from across the room. Everything that is wrong right now, in type large enough to see from four metres.
sidebar_order: 14
---

Put the Wallboard on a TV and your team can see at a glance whether anything is wrong right now. It shows the same data as the rest of Infrawrench, in type big enough to read from four metres away.

To use it, open **Wallboard** from the sidebar, go full screen and leave it running.

<insert [The Wallboard on the overview panel, dark background, four large tiles (Open incidents, Probes up, Monitors breaching, Accounts syncing) with numbers in very large type] here>

## What it shows

The wallboard only shows things that are true right now and worth walking over to look at. That's four tiles, plus two more panels when there's something to report:

| Panel           | Shows                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**    | Open incidents · probes up · monitors breaching · accounts syncing                                                                                                                      |
| **Incidents**   | Each open [incident](./incident-mode.md), its severity, and how long it has been running                                                                                                |
| **Not healthy** | [Probes](./synthetic-probes.md) that are down, [query monitors](./query-monitors.md) breaching or unable to run, [SLOs](./slos.md) spent or burning fast, accounts that stopped syncing |

Once your organization has an [SLO](./slos.md), a fifth tile appears: **Lowest error budget**, naming the SLO closest to running out.

There are no trends, history, cost breakdowns or charts. You'll find those on the regular pages once you've walked over. A panel with nothing on it is hidden.

## Colours

The wallboard uses three colours, green, amber and red, because that's what people can tell apart reliably from across a room.

**Red** means customers are affected right now: a sev1 incident or a probe that's down. Anything else that's wrong shows as amber.

## When data can't be read

If one of the sources behind the tiles can't be read, the wallboard says which one and turns amber. It will never show green just because a check failed.

If a refresh fails, the last reading stays on screen with a "not updating" marker instead of going blank.

## Rotation

Panels rotate every 20 seconds. Click **Hold this panel** to stop on the current one.

Rotation follows the clock, so two TVs in the same room show the same panel at the same time.

## Set up a screen

The wallboard is a normal signed-in page. It shows incident titles, probe names and account names, so unlike the [calendar feed](./ops-calendar.md) or a [status page](./status-pages.md), it isn't public. Sign the machine in once and bookmark the URL.

You can tune it with URL parameters:

- `?refreshSeconds=` sets how often it refreshes.
- `?rotateSeconds=` sets how often panels rotate.

Out-of-range values are adjusted to the nearest allowed value rather than rejected, so a typo won't leave you with a blank screen.

Viewing the wallboard needs the **Resources: read** permission.

## Use the API

`GET /api/org/{orgId}/wallboard` returns exactly what the screen shows. See the [OpenAPI reference](../team-and-billing/openapi.md).
