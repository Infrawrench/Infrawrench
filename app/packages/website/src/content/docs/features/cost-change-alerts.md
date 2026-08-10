---
title: Cost change alerts
description: Configured alerts that fire when spend on a chosen scope moves more than a chosen percent or amount versus the prior period, on a daily, weekly, or monthly cadence.
---

A change alert answers one question the other two cost alert families don't: **"tell me when
spend on this scope moves more than X% (or $Y) versus the prior period."** You pick the scope,
the cadence, the direction, and the threshold; Infrawrench compares each period to the one
before it and alerts when the movement clears the bar.

## Three alert families, three different questions

Infrawrench has three ways to be told about spend, and they are deliberately not the same
feature:

- **[Budgets](./cloud-costs.md)** watch an **absolute monthly total you chose** — "alert me
  when Production AWS passes $10,000 this month." The number is fixed; the alert is about
  crossing it.
- **[Anomaly detection](./cost-anomaly-alerts.md)** watches for **statistical outliers against
  a learned baseline**, with no configuration at all — "something spiked far outside its own
  history." You don't tell it what normal is; it learns.
- **Change alerts** (this page) watch a **configured relative change on a scope you chose** —
  "the api-gateway service moved more than 25% and more than $100 week over week." You state
  what movement matters; nothing is learned and nothing is absolute.

A 15% creep across a whole account will never be a statistical outlier and may sit comfortably
under a budget for months — a change alert is the tool that catches it deliberately.

## Windows: what is compared to what

All windows are made of **complete UTC days** — the current, still-accruing day never counts,
because a partial day always reads as a drop. The comparisons are like-for-like on purpose:

- **Daily** — one complete day vs **the same weekday one week earlier**. Yesterday's Tuesday is
  compared to last Tuesday, never to Monday, so ordinary weekday/weekend seasonality doesn't
  read as a change.
- **Weekly** — the **last 7 complete days** vs the **7 complete days before them**.
- **Monthly** — **month-to-date** (the current month's complete days) vs **the same number of
  days at the start of the prior month**, clamped to that month's length (30 days of March
  compare against all 28 of February). It is never month-to-date vs the _full_ prior month —
  that comparison reads "down 70%" on the 9th of every month and means nothing.

Provider billing data is restated for a few days after the fact, so windows are re-evaluated
as late data lands. Each cadence period — a day, a calendar week, a month — fires **at most
once** per watched group and currency, however many times it is re-examined.

## Thresholds: percent, amount, or both

An alert carries a percent threshold, an absolute amount threshold, or both:

- **Percent** — the movement must be at least this percent of the prior window's spend.
- **Amount** — the movement must be at least this many dollars (in the compared currency).
- **Both set** — the movement must clear **both** bars before the alert fires. This is the
  recommended shape: percent alone pages someone about a 50% jump on $2 of spend, and amount
  alone pages about a 0.4% wobble on a very large bill.

Direction is part of the alert: increases only, decreases only, or either way.

## Scope and per-group watching

The scope is the same filter vocabulary budgets and cost graphs use — provider, account,
service, region, resource, tag, charge type, commitment. An empty scope is all spend.

An alert can watch the scope's **one total**, or watch **each group of a dimension
separately** — "each service", "each account", "each value of the team tag." A grouped alert
compares every group against its own prior window, and each offending group fires its own
event, so one alert covers "any service that moves" without naming the services up front.

Two group situations are handled explicitly rather than left to arithmetic:

- **New spend** — a group present now with no spend at all in the prior window. The percent
  change is infinite, so no percentage is shown (events say `new`), any percent threshold
  counts as cleared, and the amount threshold still applies — which is exactly why a grouped
  percent-only alert benefits from an amount floor.
- **Vanished spend** — a group with prior spend and none now. That is a −100% decrease of its
  whole prior amount, visible to alerts that watch decreases.

## Currencies

Comparison is per currency — amounts in different currencies are never summed or compared
against each other. If your organization has a
[display currency and stated exchange rates](./cloud-costs.md), spend is converted into it
first, so a mixed-currency scope compares one number. A currency the organization holds no
rate for is compared **in its own currency** — it is never dropped from evaluation.

## Managing alerts

Change alerts live on the **Costs panel**, next to the anomalies section, on both web and
desktop. The list shows each alert's cadence, threshold, scope, and when it last fired;
recent firings are listed underneath with the previous → current amounts and the change.

<insert [Costs panel change-alerts section showing two configured alerts (one weekly per-service alert, one monthly total alert) and a recent-firings table with previous → current amounts and percent deltas] here>

Creating or editing an alert opens a modal with the cadence, direction, thresholds, group-by
picker, and the same filter rows the budget editor uses.

<insert [Change alert editor modal with a weekly cadence selected, both thresholds filled in (25% and $100), "Each service separately" chosen in the Watch picker, and one provider filter row] here>

Reads require the `costs:read` permission; creating, editing, and deleting require
`costs:write`. Mutations are recorded in the [audit log](../team-and-billing/audit-log.md).

## Notifications

Fired events flow through [alert routing](./alert-routing.md) as their own trigger kind,
**Cost changes** — routing rules, quiet hours, and escalation apply to them exactly as they do
to budgets and anomalies, and a rule can match on the size of the movement ("cost changes over
$500 → #incidents"). Push notifications deep-link to the Costs tab in the
[mobile app](./mobile-app.md), where the alerts and their recent firings are listed read-only.

## CLI and API

The [CLI](./cli.md) lists alerts and recent firings:

```
infrawrench costs --alerts            # alerts + recent firings, as tables
infrawrench costs --alerts --json     # the same, as JSON
infrawrench costs --alerts --limit 50 # more firings
```

The HTTP API exposes the same surface under `/api/org/:orgId/cost-alerts` (CRUD plus
`/cost-alerts/events`), and the MCP/chat tools `list_cost_alerts`,
`list_cost_alert_events`, `create_cost_alert`, and `delete_cost_alert` manage them from an
agent. See the [API reference](../team-and-billing/openapi.md).
