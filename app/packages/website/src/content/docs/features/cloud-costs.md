---
title: Cost graphs & budgets
description: Spend graphs, budgets, and overspend alerts for your connected accounts, right on the dashboard.
sidebar_order: 2
---

Cost graphs turn the billing data from your connected provider accounts into dashboard widgets: spend over time, broken down by provider, account, service, region, resource, or tag — plus monthly budgets that alert you before the bill does.

> **Cloud only.** Cost collection runs on Infrawrench Cloud's background pollers and time-series store. On the desktop app the widgets appear when you are signed into a cloud org; local-only mode does not collect cost data.

## Add a cost graph

1. Open a dashboard and click the **+** tile.
2. Choose **Cost graph**.
3. Pick a chart type, date range, and grouping, then **Save**.

<insert [Dashboard "+" tile open with the add menu showing Pin a resource / Cost graph / Budget] here>

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

A budget is a monthly amount tracked against a scope — all spend, or a filtered slice (one provider, one account, a tag). Add one from the **+** tile → **Budget**.

Each budget has one or more thresholds:

- **Actual spend** thresholds fire when month-to-date spend crosses a percentage of the budget.
- **Forecast** thresholds fire when the projected month-end total crosses it — early warning while there is still time to react.

Every threshold fires at most once per calendar month. Alerts show up as a badge on the budget card, as a [mobile push notification](./mobile-push-notifications.md) to org members who have the app installed and budget alerts enabled in their per-org notification preferences, in any [Slack](./slack-alerts.md) or [Microsoft Teams](./teams-alerts.md) channel opted into budget alerts, and — if your org has Twilio configured on the **Settings → Notifications** page — as an SMS to your on-call recipients.

<insert [Budget card showing a progress bar at 72% with threshold ticks, a forecast marker, and an alert badge] here>

## Ask the model instead

The same cost data is exposed through the [MCP server](./mcp.md) and the [AI chat](./ai-chat.md) as `query_costs`, `list_cost_dimension_values`, `get_cost_status`, and the budget tools — so "what did we spend on AWS last month, grouped by service?" works from Claude Desktop or the in-app chat without building a graph first. Cost and budget tools respect the caller's `costs:read` / `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md).

## Where the data comes from

Each provider plugin that supports cost reporting fetches spend from that provider's own billing API, once a day per account (billing APIs are rate-limited, and some — AWS Cost Explorer — charge per request). When you first connect an account, Infrawrench backfills up to a year of history in the background; the graph shows "Backfilling…" until it completes. Recent days are re-fetched on every collection so provider restatements (late-arriving usage, credits) are absorbed.

Some providers only publish monthly invoice totals rather than daily costs. Their spend appears on period boundaries, and daily-binned graphs will show it as month steps — the graph notes this when such a provider is in scope.

### Spend from somewhere else

For anything with no provider plugin — a SaaS invoice, an internal chargeback, a colo bill — a [workflow](./workflows.md#reporting-your-own-cost-data) can report the numbers itself with `infra.costs.write(...)`. Those rows land in the same store the collectors write to, so they show up in graphs, dimension filters, and budgets like any other spend. They report **Workflow** as their provider and, unless the workflow attributes them to one of your accounts, appear in the account dimension as "&lt;workflow name&gt; (workflow)".

## When collection fails

Collection runs unattended and retries with a growing backoff, so a provider that needs setup would otherwise just look like an account with no spend. Instead, the last failure is kept against the account and shown as a banner above the cost widgets on the dashboard — on web, desktop, and above **Budgets** on mobile:

<insert [Dashboard with an amber "Cost collection is failing for Infrawrench GCP" banner above the cost widgets, showing the billing-export message and its link] here>

Where the plugin can tell exactly what is missing, the banner carries a link straight to the provider page that fixes it — for example GCP's Cloud Billing export settings for the account's project. Fix the cause and the next collection backfills the days that were missed; the banner clears itself on the first success.

`infrawrench costs` prints the same warnings above the chart, and includes them as `collectionFailures` under `--json`. The `get_cost_status` MCP tool and `GET /costs/status` return the failure as `costPollError` with an optional `helpLink`.

See each plugin's page under [Plugins](../plugins/aws.md) for what its cost integration needs (extra IAM permissions, token scopes) and any caveats such as list-price-only dollars.

## Forecasts are trend estimates

Forecasts are a least-squares fit over the trailing 30 days of daily totals, projected forward. They are a trend estimate, not a billing prediction — one-off purchases, reserved-instance charges, and tier changes will not be anticipated.
