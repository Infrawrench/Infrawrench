---
title: Cost graphs & budgets
description: Spend graphs, budgets, and overspend alerts for your connected accounts, right on the dashboard.
sidebar_order: 2
---

Cost graphs turn the billing data from your connected provider accounts into dashboard widgets: spend over time, broken down by provider, account, service, region, resource, or tag — plus monthly budgets that alert you before the bill does.

The **Costs** panel in the sidebar is where your budgets live. Dashboards show cards, but the panel is the list — see [The Costs panel](#the-costs-panel).

> **Cloud only.** Cost collection runs on Infrawrench Cloud's background pollers and time-series store. On the desktop app the widgets appear when you are signed into a cloud org; local-only mode does not collect cost data.

> Costs are **billed history**. For what a resource you are about to create or resize _would_ cost, see [live cost estimates](./cost-estimates.md).

## Add a cost graph

1. Open a dashboard and click the **+** tile.
2. Choose **Cost graph**.
3. Pick a chart type, date range, and grouping, then **Save**.

<insert [Dashboard "+" tile open with the add menu showing Pin a resource / Cost graph / New budget / Existing budget] here>

<insert [Cost graph config modal with chart type, binning, date range, group-by, and a provider filter row] here>

Cost and budget cards drag around the grid like pinned resources, and share the same order — see [Arrange cards](./dashboard.md#arrange-cards).

### What you can configure

| Option     | Choices                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| Chart type | Stacked bar, multi bar, line, area, pie                                                    |
| Binning    | Daily, weekly, monthly, cumulative                                                         |
| Date range | Last 7/30/90 days, month/quarter/year to date, last month, last 12 months, or custom dates |
| Group by   | Provider, account, service, region, resource, or tag                                       |
| Filters    | Any of the same dimensions, `is` / `is not`, multiple rules                                |
| Top groups | Show the top N groups (default 5); the rest fold into **Other**                            |
| Compare    | Overlay the previous period as a dashed line, with a % change badge                        |
| Forecast   | Project the recent trend forward as a dashed continuation                                  |

<insert [A stacked-bar cost graph grouped by service with a forecast dashed line and previous-period comparison] here>

Currencies are never merged: if your accounts bill in more than one currency the graph shows one series per currency and says so under the title.

## Budgets & alerts

A budget is a monthly amount tracked against a scope — all spend, or a filtered slice (one provider, one account, a tag). Create one from the **Costs** panel, or from a dashboard's **+** tile → **New budget**.

Each budget has one or more thresholds:

- **Actual spend** thresholds fire when month-to-date spend crosses a percentage of the budget.
- **Forecast** thresholds fire when the projected month-end total crosses it — early warning while there is still time to react.

Every threshold fires at most once per calendar month. Alerts show up as a badge on the budget card, as a [mobile push notification](./mobile-push-notifications.md) to org members who have the app installed and budget alerts enabled in their per-org notification preferences, in any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel opted into budget alerts, and — if your org has Twilio configured on the **Settings → Notifications** page — as an SMS to your on-call recipients.

<insert [Budget card showing a progress bar at 72% with threshold ticks, a forecast marker, and an alert badge] here>

Budgets alert on totals you chose. For spend you didn't see coming — a provider or service suddenly billing far above its own baseline, or one that had never billed at all — see [cost anomaly alerts](./cost-anomaly-alerts.md), which work with no configuration and can be [tuned](./cost-anomaly-alerts.md#tuning-detection) if the defaults are too loud or too quiet. Anomalies can text the same on-call recipients as a budget crossing, but unlike budgets they [do not until you ask them to](./cost-anomaly-alerts.md#paging-by-sms).

## The Costs panel

**Costs** in the sidebar opens month-to-date spend for the whole org — broken down by provider, account, or service — then every budget you have, then [tag compliance, untagged spend, and showback](./tag-policy-and-showback.md), then recently detected [anomalies](./cost-anomaly-alerts.md), and finally the resources that look wasted.

A budget belongs to the org, not to a dashboard. It keeps evaluating and keeps alerting whether or not anything is showing it, which is why the panel exists: it is the one place a budget is always reachable. Each row says which dashboards carry a card for it, or **On no dashboard** when none do.

From a budget's row you can:

- **Edit** it — amount, scope filters, and thresholds.
- **Dashboards** — add or remove its cards, one per dashboard.
- **Delete** it — the budget stops evaluating and stops alerting, and its cards are removed from every dashboard at the same time.

### Cards vs the budget itself

The two directions are deliberately not symmetrical:

| You do this                            | What happens                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Remove a budget card from a dashboard  | The card goes. The budget stays, keeps tracking, keeps alerting.        |
| Delete the budget from the Costs panel | The budget goes, alerts stop, and every card pointing at it is removed. |

So removing a card is a display change, and deleting a budget is the real one.

### Show an existing budget on a dashboard

A dashboard's **+** tile offers both halves:

- **New budget** creates a budget and puts a card for it on this dashboard.
- **Existing budget** picks one you already have. Budgets already on this dashboard are not listed.

The same budget can appear on as many dashboards as you like — one budget, many views of it.

<insert [Costs panel showing the month-to-date spend chart at the top and two budget cards below, one labelled "On no dashboard"] here>

### Potential savings

Below the budgets, **Potential savings** lists resources that look orphaned or idle — volumes attached to nothing, IPs assigned to nothing — with the trailing 30-day spend where the provider reports cost per resource. It reads the state your accounts last synced, so it costs no provider API calls. The section also appears in local-only desktop mode, scanning this machine's workspace without a cost column. See [Orphan & idle resource finder](./orphan-finder.md) for what each provider flags.

### Oversized

Under Potential savings, **Oversized** covers the other half of waste: machines doing real work on more hardware than they use. Infrawrench computes each machine's p95 CPU/memory over the last 14 days of stored metrics and, where it sits well under the size, recommends the provider's cheapest smaller size that still leaves headroom — with a live-priced monthly saving and a one-click apply. See [Right-sizing](./right-sizing.md).

### Sleep schedules

Below that, **Sleep schedules** manages the org's off-at/on-at windows: stop a staging VM at 19:00 and start it at 08:00, Mon–Fri, with the projected monthly saving computed from its trailing spend. Schedules are created from an eligible resource's Schedule tab; this section lists them all with the next transition, the last run's outcome, and pause/edit/delete. See [Sleep/wake schedules](./sleep-schedules.md).

## On your phone

Cost graphs and budgets render on the [mobile app](./mobile-app.md) too — the same query, the same series colors, the same thresholds and forecast marker, drawn natively. The **Costs** tab mirrors the panel: month-to-date spend and every budget in the org, so a budget push always has somewhere to land even when no dashboard shows that budget. Cost cards also appear on whichever dashboards carry them. Creating and editing works there too: **Edit** on a dashboard offers the same **Add a card** choices and the same graph and budget editors, rendered as chips rather than dropdowns. Only a cost graph's custom absolute date range stays on web and desktop.

## Ask the model instead

The same cost data is exposed through the [MCP server](./mcp.md) and the [AI chat](./ai-chat.md) as `query_costs`, `list_cost_dimension_values`, `get_cost_status`, and the budget tools — so "what did we spend on AWS last month, grouped by service?" works from Claude Desktop or the in-app chat without building a graph first. Cost and budget tools respect the caller's `costs:read` / `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md).

## Where the data comes from

Each provider plugin that supports cost reporting fetches spend from that provider's own billing API, once a day per account (billing APIs are rate-limited, and some — AWS Cost Explorer — charge per request). When you first connect an account, Infrawrench backfills up to a year of history in the background; the graph shows "Backfilling…" until it completes. Recent days are re-fetched on every collection so provider restatements (late-arriving usage, credits) are absorbed.

The backfill is only considered done once it has actually returned a row. A provider that is set up correctly but has nothing to report yet — a billing export switched on an hour ago — keeps its full history window until real data arrives, so the history is not skipped just because the first attempt was early.

Some providers only publish monthly invoice totals rather than daily costs. Their spend appears on period boundaries, and daily-binned graphs will show it as month steps — the graph notes this when such a provider is in scope.

### Spend from somewhere else

For anything with no provider plugin — a SaaS invoice, an internal chargeback, a colo bill — you can report the numbers yourself, and they land in the same store the collectors write to, so they show up in graphs, dimension filters, and budgets like any other spend. Two ways in:

- A [workflow](./workflows.md#reporting-your-own-cost-data) calling `infra.costs.write(...)`, when the numbers are reachable from Infrawrench. These report **Workflow** as their provider and, unless the workflow attributes them to one of your accounts, appear in the account dimension as "&lt;workflow name&gt; (workflow)".
- A server of your own [pushing rows over the API](./server-push.md#cost-rows) to `POST /costs/rows`, when they aren't. These report **External** as their provider and appear as "&lt;source&gt; (external)".

Either way, re-reporting a day restates it rather than adding to it, and neither can overwrite a row a provider collector wrote.

## When collection fails

Collection runs unattended and retries with a growing backoff, so a provider that needs setup would otherwise just look like an account with no spend. Instead, the last failure is kept against the account and shown as a banner above the cost widgets on the dashboard — on web, desktop, and mobile alike:

<insert [Dashboard with an amber "Cost collection is failing for Infrawrench GCP" banner above the cost widgets, showing the billing-export message and its link] here>

Where the plugin can tell exactly what is missing, the banner carries a link straight to the provider page that fixes it — for example GCP's Cloud Billing export settings for the account's project. Fix the cause and the next collection backfills the days that were missed; the banner clears itself on the first success.

`infrawrench costs` prints the same warnings above the chart, and includes them as `collectionFailures` under `--json`. The `get_cost_status` MCP tool and `GET /costs/status` return the failure as `costPollError` with an optional `helpLink`.

## When there is nothing to collect yet

Collection can also succeed and come back with nothing. This is normal for a freshly configured provider: GCP's Cloud Billing export to BigQuery, for instance, creates its table immediately but can take a day or two to write the first rows, and until then every collection legitimately returns no spend.

Because nothing failed, there is no error to report — so the account gets its own, calmer banner instead of a blank graph with no explanation:

<insert [Dashboard showing the neutral "No spend data yet for Infrawrench GCP" banner above an empty cost widget] here>

It clears itself the moment the first row lands. If it persists for more than a couple of days, the export is usually configured but not actually delivering — check it at the provider rather than in Infrawrench.

`infrawrench costs` lists these accounts above the chart too, and includes them as `awaitingData` under `--json`. Over `GET /costs/status` the state is an account with no `costPollError` and a null `coverage`.

See each plugin's page under [Plugins](../plugins/aws.md) for what its cost integration needs (extra IAM permissions, token scopes) and any caveats such as list-price-only dollars.

## Forecasts are trend estimates

Forecasts are a least-squares fit over the trailing 30 days of daily totals, projected forward. They are a trend estimate, not a billing prediction — one-off purchases, reserved-instance charges, and tier changes will not be anticipated.
