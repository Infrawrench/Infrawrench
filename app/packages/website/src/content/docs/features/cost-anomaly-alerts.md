---
title: Cost anomaly alerts
description: Automatic detection of unusual spend spikes and brand-new spend sources per provider and per service, with alerts through push, Slack, and Microsoft Teams.
---

Infrawrench watches your collected spend for anomalies. Once a day, after cost
collection runs for your accounts, it compares yesterday's spend for every provider and every
service against that provider's or service's own trailing baseline. A day that lands far above
the baseline raises an anomaly, which shows up on the Costs panel and — if you have
notifications configured — arrives as a push notification, a Slack message, or a Teams card.

Unlike [budgets](./cloud-costs.md), which alert when a monthly total you chose
crosses a threshold you chose, anomaly detection works out of the box: the baseline is
learned from your own history, so a spike stands out whether your org spends fifty dollars a
month or fifty thousand. The thresholds it judges against can be
[tuned per organization](#tuning-detection) when the defaults are too loud or too quiet.

## Two kinds of finding

The anomalies list mixes two detections, marked distinctly:

- A **spike** — a provider or service spending far more today than its own recent history says
  it should.
- A **new spend source** — a provider or service that spent nothing at all across the trailing
  window and suddenly bills a material amount. This is the case no statistical test can catch:
  with a baseline of zero there is no average or deviation to exceed, so a jump from $0 to
  $5,000 clears no bar at all. It is also often the most important thing to see, because that
  is what a leaked key, a mistakenly enabled service, or a fat-fingered instance type looks
  like on a bill.

The two are mutually exclusive for a given day and key: anything with a baseline worth
measuring against is judged as a spike, and only a key with no baseline can be a new source.

## How detection works

- Detection runs against **yesterday and the two days before it** (UTC), never today — today is
  still accruing and would read as a dip, never a spike. Each pass re-judges that short window
  rather than only the newest day, because a day's spend is not final when the day ends:
  providers restate late, and your accounts collect at staggered times, so a day looked at once
  and early can be missing most of its data. Re-judging it as it fills in is what stops a real
  spike from being missed.
- Each provider's and each service's spend is compared against its **trailing 28-day
  baseline**: the mean daily spend plus a number of standard deviations (three, by default). A
  day above that bar is a spike.
- A **minimum absolute rise** over the baseline ($10 by default, converted for other
  currencies) filters out penny-scale noise — a $0.02 day against a $0.001 baseline is many
  deviations out and still not worth an alert.
- Keys with fewer than **7 days of spend history** are never judged as spikes: a brand-new
  service has no baseline worth trusting yet.
- A key that spent **effectively nothing across the whole 28-day window** and then bills more
  than the **new-source floor** ($25/day by default) is reported as a new spend source instead.
  "Effectively nothing" means it spent less over the entire window than that floor covers for a
  single day, which tolerates the sub-cent trial usage real bills are full of.
- New spend sources need **7 days of cost collection** behind them before any are reported.
  On the day you connect your first account every provider and every service is technically
  new, and that is a fact about how long we have been looking rather than about your spend.
  This is measured across the organization, so a genuinely new provider or service inside an
  established organization still alerts the day it appears.
- Detection is per currency. Mixed-currency orgs get independent baselines per currency,
  the same way cost graphs never merge currencies, and every floor is converted so it means the
  same real amount whether a provider bills in dollars or yen.

## Tuning detection

The **Tune detection** button on the Costs panel's Anomalies section opens three controls,
stored per organization:

| Control              | What it does                                                                               | Default | Range         |
| -------------------- | ------------------------------------------------------------------------------------------ | ------- | ------------- |
| **Sensitivity (σ)**  | Standard deviations above a key's own average before a day is a spike. Lower catches more. | 3       | 1 – 10        |
| **Spike floor**      | The minimum rise over the baseline a spike must also clear, in USD.                        | $10     | $1 – $100,000 |
| **New-source floor** | The minimum first-day spend before a provider or service with no history alerts, in USD.   | $25     | $1 – $100,000 |

The bounds are enforced by the server, not just the form. A sensitivity of 0 would flag every
day a cent above average, and anything under 1σ flags roughly a third of ordinary days; a floor
of zero or less removes the noise filter entirely. The upper bounds exist so a typo — entering
a floor in cents when the field asks for dollars — cannot silently switch detection off.

Everything else about the model is fixed: the 28-day baseline, the 7-day alert cooldown, and
the minimum history a baseline needs are properties of the data rather than preferences.

Changes take effect on the next detection pass, which runs after the next cost collection.
Anomalies already found are not re-judged, so lowering the sensitivity does not retroactively
surface older days.

Reading the settings needs the `costs:read` permission; changing them needs `costs:write` — the
same scope as [pushing your own cost rows](./server-push.md), because retuning changes what your
whole cost feed alerts on. A member without it sees what detection is tuned to, without the
controls.

Tuning is a web and desktop feature. The mobile app lists anomalies but does not edit the
thresholds: they are organization-wide settings that change what everyone's alerts look like,
and the control you actually want on a phone — turning the notifications off for yourself — is
the "Cost anomalies" toggle in the app's notification settings.

<insert [Costs panel Anomalies section with the tuning panel expanded, showing the Sensitivity, Spike floor, and New-source floor inputs with their default values] here>

## Deduplication and cooldown

The same anomaly never re-alerts. Both kinds share these rules — a new spend source that keeps
spending becomes an ordinary key with a baseline within days, and telling you about it every
morning in between would be noise:

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
percentage change. New spend sources carry a **New source** badge, and show `none` for the
baseline and `new` for the change — a key with no prior spend has no percentage to be up by.

<insert [Costs panel showing the Anomalies section with a mix of rows — a spike with a red percentage change, and a new spend source with its New source badge, "none" baseline, and "new" change] here>

The **mobile app** shows the same list on its **Costs** tab, under the month-to-date chart and
your budgets, with the same distinction between the two kinds. Tapping a cost anomaly push
notification opens it. Detection thresholds are read-only there — see below.

<insert [Mobile app Costs tab scrolled to the Anomalies section, showing a spike row with its baseline and percentage change and a new-spend-source row with its New source badge and "new" change] here>

## From the CLI

The [desktop CLI](./cli.md) prints the same list:

```sh
infrawrench costs --anomalies              # the last 30 days
infrawrench costs --anomalies --days 7     # a shorter window (1-90)
infrawrench costs --anomalies --last 2w    # the same window, said the other way
infrawrench costs --anomalies --json       # stable JSON for scripting
```

It is a flag on `costs` rather than a command of its own: it answers a question about the same data the chart draws. Text mode prints a table of the day, what spiked (the provider or service, and which of the two it is), the actual spend, the trailing baseline per day, and the percentage change — `new` where the key had no baseline to be up from. New spend sources are marked `[new source]` and print `none` for their baseline. A `notified` column shows the day the alert was delivered, or a dash for anomalies detected while no channel was connected or inside another anomaly's cooldown.

The `--json` output carries a `kind` field on every row (`spike` or `new_source`), so a script can route the two differently.

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
requested window (1–90 days), newest first. Each row carries a `kind` of `spike` or
`new_source`; rows detected before new-source detection existed read as `spike`. For a
`new_source`, `baselineCents` is zero or near it — do not compute a percentage change from it.

The thresholds are readable and writable too:

```
GET /api/org/{orgId}/costs/anomaly-settings
PUT /api/org/{orgId}/costs/anomaly-settings
```

`GET` needs `costs:read` and answers with the defaults for an organization that has never
changed them. `PUT` needs `costs:write` and replaces the whole object — `sigmas`,
`minDeltaCents`, and `newSourceMinCents` are all required, and out-of-range values are rejected
with a 400 rather than clamped. See the [API reference](../team-and-billing/openapi.md) for the
full schema.
