---
title: "Capacity runway: see what will run out first"
description: See when a volume, database, or monthly allowance is likely to hit its limit, and get a warning in the Infrawrench Quotas digest.
date: 2026-11-23
author: The Infrawrench team
---

A volume at 92% tells you how much disk is left. It doesn't tell you whether you have until tomorrow or next month to resize it. And a monthly transfer allowance at 70% means something different on the fifth of the month than it does on the last day.

Capacity runway adds that missing time estimate to Infrawrench. Open **Quotas** on web or desktop to see tracked limits across your connected accounts, with the resources expected to run out soonest at the top.

![Capacity runway in the Infrawrench Quotas tab, showing usage, limits and time remaining](https://agent-assets.infrawrench.com/docs-screenshots/features/quota-radar/capacity-runway.png)

## Two kinds of limit, two forecasts

For a fixed ceiling, such as a Railway volume's storage limit, Infrawrench estimates when usage will reach it based on recent readings. Open the resource's **Metrics** tab to see the usage history, the limit and the projected crossing on the same chart.

![Railway volume Metrics tab showing the usage history and its projected crossing of the storage limit](https://agent-assets.infrawrench.com/docs-screenshots/features/quota-radar/resource-runway-chart.png)

For a monthly allowance, such as Hetzner's included server traffic, the view estimates how much you'll use by the end of the current cycle and flags a projected crossing before the reset. It uses readings from the current cycle, so last month's traffic doesn't skew the forecast.

A new resource can show **No trend yet** while readings accumulate. Noisy trends stay visible, but the projection alone won't trigger an alert. See the [list of tracked limits](/docs/features/quota-radar#whats-tracked) for coverage. Limits that depend on stored metrics require the resource to be pinned to a dashboard.

## See what needs attention

Start in **Quotas → Capacity runway**. The daily Quotas digest can flag limits already reached, reliable projections within your warning window, and monthly allowances nearing exhaustion. Change the warning thresholds under **Settings → Notifications → Alerts & digest**.

Prefer a terminal? Run `infrawrench runway --at-risk` to see the rows that need attention, or add `--json` for scripts.
