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

<insert [Dashboard with a Droplet card, an EKS cluster card, and a Postgres database card] here>

## What cards show

Each card shows the same summary the sidebar uses — name, status badge, and one or two key facts (region, size, replica count, etc.). Cards auto-refresh every 30 seconds along with the sidebar.

## Historical metrics

Pinned resources accumulate metric history. The dashboard sparkline on each card shows the most recent values; opening a pinned resource's **Metrics** tab lets you zoom out to longer windows (1 hour, 24 hours, 7 days, 30 days).

Behind the scenes, the poller writes a datapoint every 15 seconds to a time-series store. Raw points are kept for 7 days, 1-minute rollups for 30 days, and 1-hour rollups for a year — so zooming out to longer ranges stays fast.

Only **pinned** resources accumulate history. Unpin a resource and its history stops being collected (existing points age out via the retention windows above).

<insert [Resource Metrics tab with a 7-day range selector showing CPU/memory series] here>

## Multiple dashboards

You can create additional dashboards from **Dashboards → New**. Useful for splitting by environment (prod, staging) or by responsibility (mine vs team).

## When the dashboard is worth using

- You manage five or more accounts and do not want to hunt through the sidebar.
- You run the same smoke-check daily (is the prod DB healthy? is the worker pod running?).
- You want a wall-display view during an incident.

If you only have a handful of resources, the sidebar is usually fast enough — don’t feel you have to pin everything.
