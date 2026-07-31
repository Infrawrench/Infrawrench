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

- Detection runs against **yesterday and the two days before it** (UTC), never today — today is
  still accruing and would read as a dip, never a spike. Each pass re-judges that short window
  rather than only the newest day, because a day's spend is not final when the day ends:
  providers restate late, and your accounts collect at staggered times, so a day looked at once
  and early can be missing most of its data. Re-judging it as it fills in is what stops a real
  spike from being missed.
- Each provider's and each service's spend is compared against its **trailing 28-day
  baseline**: the mean daily spend plus three standard deviations. A day above that bar is
  anomalous.
- A **minimum absolute rise** over the baseline (about $10, converted for other currencies)
  filters out penny-scale noise — a $0.02 day against a $0.001 baseline is many deviations out
  and still not worth an alert.
- Keys with fewer than **7 days of spend history** are skipped: a brand-new service has no
  baseline worth trusting yet.
- Detection is per currency. Mixed-currency orgs get independent baselines per currency,
  the same way cost graphs never merge currencies.

## Deduplication and cooldown

The same anomaly never re-alerts:

- Each (day, provider-or-service, currency) combination alerts **at most once**, no matter how
  many collection passes re-examine that day. If a day's figures are revised upward by later
  data, the anomalies list updates to show the corrected amount, but no second alert is sent.
- After you are **notified** about a provider or service, further anomalies for the same one
  are **suppressed for 7 days**. A sustained price jump is anomalous against the trailing
  window for several days running; you get told once, not every morning. The suppressed days
  still appear in the anomalies list so the record is complete.
- The cooldown counts only anomalies that actually reached you. An anomaly detected while no
  channel was connected — or one whose delivery failed — does not start a quiet period, and
  stays eligible to be sent for as long as its day is still in the evaluation window. Connect
  Slack, Teams, or mobile push and the next collection pass delivers what is still pending.

## Where anomalies appear

The Costs panel (web and desktop) has an **Anomalies** section listing the last 30 days:
the day, what spiked, the actual spend, the baseline it was measured against, and the
percentage change.

<insert [Costs panel showing the Anomalies section with a few detected anomalies — day, provider/service, spend vs baseline, and the red percentage-change column] here>

## From the CLI

The [desktop CLI](./cli.md) prints the same list:

```sh
infrawrench costs --anomalies              # the last 30 days
infrawrench costs --anomalies --days 7     # a shorter window (1-90)
infrawrench costs --anomalies --last 2w    # the same window, said the other way
infrawrench costs --anomalies --json       # stable JSON for scripting
```

It is a flag on `costs` rather than a command of its own: it answers a question about the same data the chart draws. Text mode prints a table of the day, what spiked (the provider or service, and which of the two it is), the actual spend, the trailing baseline per day, and the percentage change — `new` where the key had no baseline to be up from. A `notified` column shows the day the alert was delivered, or a dash for anomalies detected while no channel was connected or inside another anomaly's cooldown.

<insert [Terminal showing `infrawrench costs --anomalies` output: the table of day, what spiked, actual vs baseline spend, the red percentage-change column, and the notified column] here>

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
