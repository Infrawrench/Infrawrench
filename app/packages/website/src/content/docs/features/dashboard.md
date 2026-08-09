---
title: Dashboard
description: Pin the resources you actually use to a draggable grid.
sidebar_order: 1
---

The dashboard is the first thing you see after sign-in. It is a grid of pinned resource cards that you choose and arrange yourself. If you do not pin anything it stays empty — that is fine.

## Pin a resource

1. Open any resource detail page.
2. Click the **Pin** icon in the top-right.
3. It shows up on the dashboard immediately.

<insert [Resource detail page with pin icon highlighted] here>

## Arrange cards

- **Drag** a card to move it. Other cards reflow.
- **Resize** from the bottom-right corner.
- **Unpin** from the card’s menu, or from the resource detail page.

Every kind of card is draggable and they all share one order, so a cost graph or budget can sit between two resource cards rather than being stuck at the end of the grid. New cards are added at the end. The order is per dashboard and shared with everyone in the org.

<insert [Dashboard with a Droplet card, an EKS cluster card, and a Postgres database card] here>

## What cards show

Each card shows the same summary the sidebar uses — name, status badge, and one or two key facts (region, size, replica count, etc.). Cards auto-refresh every 30 seconds along with the sidebar.

## Historical metrics

Pinned resources accumulate metric history. The dashboard sparkline on each card shows the most recent values; opening a pinned resource's **Metrics** tab lets you zoom out to longer windows (1 hour, 24 hours, 7 days, 30 days).

Behind the scenes, the poller writes a datapoint every 15 seconds to a time-series store. Raw points are kept for 7 days, 1-minute rollups for 30 days, and 1-hour rollups for a year — so zooming out to longer ranges stays fast.

Only **pinned** resources accumulate history. Unpin a resource and its history stops being collected (existing points age out via the retention windows above).

Unpinned resources still get a chart: when a resource has no accumulated history, the Metrics tab fetches the series live from the provider on demand. Pinning is what buys you the long ranges and retention — the live fetch only covers whatever window the provider itself serves.

<insert [Resource Metrics tab with a 7-day range selector showing CPU/memory series] here>

## Cost graphs and budgets

The **+** tile on a dashboard is a menu: pin a resource, add a **Cost graph**, create a **New budget**, place an **Existing budget** you already have, or add a **Custom graph** (cloud orgs only). Cost widgets chart the actual spend of your connected accounts and track monthly budgets with alerts — see [Cost graphs & budgets](./cloud-costs.md). Custom graphs are script-defined charts with their own controls — see [Custom graphs](./custom-graphs.md). They drag into place alongside resource cards like anything else on the grid; cost graphs and custom graphs occupy two columns.

Budget cards are views onto a budget, not the budget itself: removing one leaves the budget tracking and alerting, and the [**Costs** panel](./cloud-costs.md#the-costs-panel) lists every budget whether or not a dashboard shows it.

<insert [Dashboard "+" tile menu open showing Pin a resource, Cost graph, New budget, Existing budget, and Custom graph entries] here>

## Multiple dashboards

You can create additional dashboards from **Dashboards → New**. Useful for splitting by environment (prod, staging) or by responsibility (mine vs team).

## On mobile

The [mobile app](./mobile-app.md) builds and edits dashboards too: **New dashboard** on the Dashboards tab, then **Edit** on a dashboard to add cards, reorder them, configure a cost graph or budget, and rename or delete the dashboard. Cards move with **Move up** / **Move down** instead of being dragged, and a cost graph's custom absolute date range stays on web and desktop — everything else is the same options over the same API, so a dashboard built on a phone opens unchanged here. See [building a dashboard on the phone](./mobile-app.md#building-a-dashboard-on-the-phone).

## When the dashboard is worth using

- You manage five or more accounts and do not want to hunt through the sidebar.
- You run the same smoke-check daily (is the prod DB healthy? is the worker pod running?).
- You want a wall-display view during an incident.

If you only have a handful of resources, the sidebar is usually fast enough — don’t feel you have to pin everything.
