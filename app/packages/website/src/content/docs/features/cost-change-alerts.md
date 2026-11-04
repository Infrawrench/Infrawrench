---
title: Cost change alerts
description: Get alerted when spend on a scope you choose moves more than a set percent or amount compared with the previous period, checked daily, weekly or monthly.
---

A change alert tells you when **spend on a scope moves more than X% (or $Y) compared with the previous period**. You pick the scope, how often it checks, the direction and the threshold. Infrawrench compares each period with the one before and alerts you when the change clears the bar.

## Which cost alert to use

Infrawrench has six kinds of cost alert, and each answers a different question. The first three compare money with money. The last three look at things a spend total doesn't show: a date, an obligation, a volume.

- **[Budgets](./cloud-costs.md)** watch a **fixed monthly total you set**: "alert me when Production AWS passes $10,000 this month."
- **[Anomaly detection](./cost-anomaly-alerts.md)** flags **spikes far outside a scope's own history**, with no setup. You don't tell it what normal is; it learns.
- **Change alerts** (this page) watch for **a relative change you define, on a scope you choose**: "the api-gateway service moved more than 25% and more than $100 week over week."
- **[Commitment expiry](./commitment-and-unit-cost-alerts.md)** watches a **term end date**. A lapsing reservation shows no change in spend until after it has happened.
- **[Idle commitments](./commitment-and-unit-cost-alerts.md)** watch **how much of what you already bought you're using**. Nothing moves; the waste has been there since the purchase.
- **[Unit-cost regressions](./commitment-and-unit-cost-alerts.md)** watch **spend divided by a business metric**. It stays quiet when spend doubles because volume tripled, and fires when spend is flat because volume halved.

A steady 15% creep across an account will never look like an anomaly and may stay under a budget for months. A change alert is how you catch it. The [comparison table](./commitment-and-unit-cost-alerts.md) puts all six side by side.

## What gets compared

Periods are made of **complete UTC days**. Today, which is still adding up, never counts, since a partial day always looks like a drop.

- **Daily:** one complete day against **the same weekday a week earlier**. Last Tuesday is compared with the Tuesday before, never with Monday, so normal weekday and weekend patterns don't look like changes.
- **Weekly:** the **last 7 complete days** against the **7 complete days before them**.
- **Monthly:** **month-to-date** (this month's complete days) against **the same number of days at the start of last month**, capped at that month's length (30 days of March compare with all 28 of February). It never compares month-to-date with the _whole_ of last month, which would show "down 70%" on the 9th of every month.

Providers often revise billing data for a few days afterwards, so periods are checked again as late data arrives. Each period (a day, a calendar week, a month) alerts **at most once** per watched group and currency.

## Set a threshold

An alert has a percent threshold, an amount threshold, or both:

- **Percent:** the change must be at least this percent of the previous period's spend.
- **Amount:** the change must be at least this much money (in the compared currency).
- **Both:** the change must clear **both** before the alert fires. We recommend this. Percent alone alerts you about a 50% jump on $2 of spend, and amount alone alerts you about a 0.4% wobble on a very large bill.

You also choose the direction: increases only, decreases only, or either way.

## Choose a scope

The scope uses the same filters as budgets and cost graphs: provider, account, service, region, resource, tag, charge type and commitment. An empty scope means all spend.

An alert can watch the scope's **total**, or watch **each group separately**, for example "each service", "each account" or "each value of the team tag". Each group is compared with its own previous period and fires its own alert, so one alert covers "any service that moves" without you naming the services.

Two cases work a little differently:

- **New spend:** a group with spend now and none in the previous period. No percentage is shown (alerts say `new`), any percent threshold counts as met, and the amount threshold still applies. This is why a per-group percent alert works best with an amount threshold too.
- **Vanished spend:** a group with spend before and none now. That counts as a 100% decrease, so alerts that watch decreases will catch it.

## Currencies

Each currency is compared separately. Amounts in different currencies are never added together. If your organization has a [display currency and exchange rates](./cloud-costs.md) set, spend is converted first, so a mixed-currency scope compares one number. A currency with no exchange rate set is compared **in its own currency**, never left out.

## Manage alerts

Change alerts are on the **Alerts** tab of the **Costs panel**, after the anomalies section, on web and desktop. The list shows each alert's period, threshold, scope and when it last fired. Recent alerts are listed underneath, with the previous and current amounts and the change.

![Costs panel change-alerts section showing two configured alerts (one weekly per-service alert, one monthly total alert) and a recent-firings table with previous → current amounts and percent deltas](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-change-alerts/alerts-and-firings.png)

Creating or editing an alert opens a dialog with the period, direction, thresholds, a "watch" picker for grouping, and the same filter rows as the budget editor.

![Change alert editor modal with a weekly cadence selected, both thresholds filled in (25% and $100), "Each service separately" chosen in the Watch picker, and one provider filter row](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-change-alerts/alert-editor.png)

Viewing alerts needs the `costs:read` permission. Creating, editing and deleting them needs `costs:write`. Changes are recorded in the [audit log](../team-and-billing/audit-log.md).

## Notifications

Change alerts go through [alert routing](./alert-routing.md) as their own trigger, **Cost changes**. Routing rules, quiet hours and escalation work just as they do for budgets and anomalies, and a rule can match on the size of the change (for example, cost changes over $500 go to #incidents). Push notifications open the **Alerts** tab of the Costs screen in the [mobile app](./mobile-app.md), where you can view alerts and their recent firings.

An alert can also email people directly. The editor's **Email recipients** field takes members and approved extra addresses, who are emailed every time the alert fires, on top of your routing rules. See [email alerts](./email-alerts.md).

## CLI and API

The [CLI](./cli.md) lists alerts and recent firings:

```
infrawrench costs --alerts            # alerts + recent firings, as tables
infrawrench costs --alerts --json     # the same, as JSON
infrawrench costs --alerts --limit 50 # more firings
```

The HTTP API has the same features under `/api/org/:orgId/cost-alerts` (create, read, update, delete, plus `/cost-alerts/events`). From an AI agent, use the MCP and chat tools `list_cost_alerts`, `list_cost_alert_events`, `create_cost_alert` and `delete_cost_alert`. See the [API reference](../team-and-billing/openapi.md).
