---
title: Cost anomaly alerts
description: Automatic detection of unusual spend spikes per provider and per service, with alerts through push, Slack, and Microsoft Teams.
---

Infrawrench watches your collected spend for statistical anomalies. Once a day, after cost
collection runs for your accounts, it compares yesterday's spend for every provider and every
service against that provider's or service's own trailing baseline. A day that lands far above
the baseline raises an anomaly, which shows up on the Costs panel and — if you have
notifications configured — arrives as a push notification, a Slack message, or a Teams card.

Unlike [budgets](./cloud-costs.md), which alert when a monthly total you chose
crosses a threshold you chose, anomaly detection needs no configuration: the baseline is
learned from your own history, so a spike stands out whether your org spends fifty dollars a
month or fifty thousand.

## How detection works

- Detection runs against **yesterday** (UTC) — the most recent day provider billing data can
  be complete for. Today is always partial and would read as a dip, never a spike.
- Each provider's and each service's spend is compared against its **trailing 28-day
  baseline**: the mean daily spend plus three standard deviations. A day above that bar is
  anomalous.
- A **minimum absolute rise** over the baseline (about $10) filters out penny-scale noise —
  a $0.02 day against a $0.001 baseline is many deviations out and still not worth an alert.
- Keys with fewer than **7 days of spend history** are skipped: a brand-new service has no
  baseline worth trusting yet.
- Detection is per currency. Mixed-currency orgs get independent baselines per currency,
  the same way cost graphs never merge currencies.

## Deduplication and cooldown

The same anomaly never re-alerts:

- Each (day, provider-or-service, currency) combination fires **at most once**, no matter how
  many collection passes re-examine that day.
- After an anomaly is raised for a provider or service, further anomalies for the same one are
  **suppressed for 7 days**. A sustained price jump is anomalous against the trailing window
  for several days running; you get told once, not every morning. The suppressed days still
  appear in the anomalies list so the record is complete.

## Where anomalies appear

The Costs panel (web and desktop) has an **Anomalies** section listing the last 30 days:
the day, what spiked, the actual spend, the baseline it was measured against, and the
percentage change.

<insert [Costs panel showing the Anomalies section with a few detected anomalies — day, provider/service, spend vs baseline, and the red percentage-change column] here>

## Alerts

Anomaly alerts ride the same channels as budget alerts and sync-failure incidents, with their
own opt-in toggle everywhere those channels are configured:

- **[Mobile push](./mobile-push-notifications.md)** — per-user, per-org toggle ("Cost
  anomalies") in **Settings → Alerting & paging** on the web, or the mobile app's
  notification settings.
- **[Slack](./slack-alerts.md)** — per-channel "Anomalies" toggle on each routed channel.
- **[Microsoft Teams](./teams-alerts.md)** — per-webhook "Anomalies" toggle on each routed
  channel.

<insert [Web settings Alerting & paging page with the "Cost anomalies" push toggle and a Slack channel row showing the Anomalies trigger checkbox] here>

All toggles default to on. Slack and Teams messages carry a "View in Infrawrench" button that
opens the Costs panel.

## API

Recent anomalies are available over the HTTP API:

```
GET /api/org/{orgId}/costs/anomalies?days=30
```

The endpoint requires the `costs:read` permission and returns up to 200 anomalies from the
requested window (1–90 days), newest first. See the [API reference](../team-and-billing/openapi.md)
for the full schema.
