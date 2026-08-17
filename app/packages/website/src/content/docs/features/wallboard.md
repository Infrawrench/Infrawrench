---
title: Wallboard
description: One screen, read from across the room — everything that is wrong right now, in type large enough to see from four metres.
sidebar_order: 14
---

Every other page here is designed for somebody sitting at it: dense tables,
hover states, filters. None of that survives being put on a television four
metres away — which is exactly where a team wants the answer to _is anything
wrong_.

**Wallboard** is a different reading of the same data. Open it from the
sidebar, press full screen, and leave it.

<insert [The Wallboard on the overview panel, dark background, four large tiles (Open incidents, Probes up, Monitors breaching, Accounts syncing) with numbers in very large type] here>

## What is on it — and what is not

One rule decides: **a wallboard may only show things that are true right now
and that somebody would cross a room to look at.**

So it shows four tiles and, when there is something to say, two more panels:

| Panel           | Shows                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**    | Open incidents · probes up · monitors breaching · accounts syncing                                                                             |
| **Incidents**   | Each open [incident](./incident-mode.md), its severity, and how long it has been running                                                       |
| **Not healthy** | [Probes](./synthetic-probes.md) that are down, [query monitors](./query-monitors.md) breaching or unable to run, accounts that stopped syncing |

And that is all. No trends, no history, no cost breakdowns, no charts. Those
are the things you look at when you _have_ walked over, and they belong on the
pages you open when you get there.

A panel with nothing on it is never shown. A wall that spends a third of its
time displaying an empty "Incidents" heading trains a room to stop looking at
it.

## Three colours

Green, amber, red — because at four metres a person distinguishes three colours
reliably and nothing more.

**Red** is reserved for the two things that mean customers are affected right
now: a sev1 incident, or a probe that is down. Everything else that is wrong is
amber. The screen's job is to make somebody walk over, not to grade the problem
for them.

## When we cannot tell

If one of the sources behind those tiles cannot be read, the wall says which
and turns amber.

That is the most important behaviour on this page. A wallboard showing green
because a query failed is worse than a blank screen — it is a screen actively
telling a room that everything is fine. For the same reason, a failed refresh
leaves the last reading on screen with a "not updating" marker rather than
blanking it.

## Rotation

Panels rotate every 20 seconds. **Hold this panel** stops it.

The rotation is derived from the clock rather than from a timer in the browser,
so two televisions in the same room show the same panel at the same moment.
Screens rotating out of step is the sort of thing people notice and nobody can
explain.

## Pointing a screen at it

The wallboard is a normal signed-in page, deliberately. Unlike the
[calendar feed](./ops-calendar.md) or a [status page](./status-pages.md), it
carries incident titles, probe names and account names — the shape of your
estate — and a screen in an office is exactly what a visitor photographs. Sign
the machine in once and bookmark the URL.

`?refreshSeconds=` and `?rotateSeconds=` tune it. Both are **clamped** rather
than validated: a wallboard URL gets typed into a television with a remote
control, and a 400 there is a black screen nobody can debug.

Reading it needs **Resources: read**.

## Over the API

`GET /api/org/{orgId}/wallboard` returns exactly what the screen draws. See the
[OpenAPI reference](../team-and-billing/openapi.md).
