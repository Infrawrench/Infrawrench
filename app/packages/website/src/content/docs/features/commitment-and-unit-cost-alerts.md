---
title: Commitment & unit-cost alerts
description: Get alerted when a reservation or savings plan is about to expire, when a commitment sits unused, and when cost per unit of a business metric goes up.
---

Budgets, anomaly detection and change alerts all watch your spend totals. Some problems don't show up there:

- A reservation ends on Tuesday. Nothing has changed yet, and by the time it does you're already paying on-demand rates.
- A savings plan is only 30% used. Nothing changes at all, because the waste started the day it was bought.
- Spend doubled because volume tripled. Everything moved, and the business actually got **better**.

These three alerts catch those cases by looking at your commitments and at the volume your spend bought. They use the same routing as your other alerts, and they're written to still make sense if you open them a few days later.

## Which alert to use

| Alert                                             | Watches                                        | Fires when                                                       | Configuration                   | Cadence                                 |
| ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| **[Budgets](./cloud-costs.md)**                   | An absolute monthly total you chose            | Spend crosses a threshold of that total                          | You set the total               | Once per threshold, monthly             |
| **[Anomaly detection](./cost-anomaly-alerts.md)** | A learned trailing baseline                    | A day's spend is a statistical outlier, or a source appears anew | None                            | Per anomalous day                       |
| **[Change alerts](./cost-change-alerts.md)**      | A scope you chose, versus its prior period     | The move clears your percent and/or amount threshold             | You set the scope and threshold | Per cadence period                      |
| **Commitment expiry** (this page)                 | A commitment's term end date                   | The term end reaches a horizon: 60, 30 or 7 days out by default  | Defaults work                   | Once per horizon per term               |
| **Idle commitments** (this page)                  | Utilization of a commitment you already bought | Utilization stays under the threshold across a whole window      | Defaults work                   | Once per commitment per month           |
| **Unit-cost regressions** (this page)             | Spend ÷ a business metric                      | Cost per unit rises past the threshold versus the prior window   | Defaults work                   | Once per metric, then a 14-day cooldown |

The first three are about **money**. The last three are about **what the money bought**. If spend rises while cost per customer falls, you get a change alert but no unit-cost regression, which is the right outcome.

## Commitment expiry

When a reservation, savings plan or committed-use discount ends, the usage it covered goes back to on-demand pricing straight away. Nothing in your spend totals warns you beforehand, so this alert does.

**When you're warned.** By default at **60, 30 and 7 days** before the term ends. Each warning fires once per commitment per term. Roughly: 60 days gives procurement time, 30 days leaves room to resize calmly, and 7 days means renew now or budget for on-demand.

If a commitment has already passed several horizons (for example, you connected the account 30 days before it ends), you get one alert for the nearest horizon, not several.

**What it costs.** Each warning shows the commitment's rate as a monthly figure and, where possible, how much usage it currently covers per month. That second number is a **lower bound** ("at least $1,180/month reverts to on-demand"), because providers don't report the on-demand price for covered usage. On-demand is never cheaper than the committed rate, so the real cost will be at least this much.

A [committed-use discount](./commitments.md) that buys vCPUs rather than dollars shows its units instead of money. It still warns you.

**Already expired.** If a commitment ended without any warning firing (because you connected the account late, or data collection started late), you get one alert at a zero-day horizon. This only covers terms that ended in the last 90 days, so connecting an old account doesn't flood you. It's on by default, and you can turn it off.

**Renewals.** Two things tell Infrawrench a commitment isn't really lapsing:

- **A replacement is already in your inventory.** Another commitment on the same account, of the same kind, region, scope and description, starts when this one ends (for example a queued AWS reservation purchase). No alert fires for the old one.
- **The provider's auto-renew flag.** A commitment known to renew fires **once**, at the shortest horizon only, at `info` severity. The message says it will renew at the current rate rather than lapse, in case you meant to cancel it.

  Today no provider's commitment data includes a renewal flag yet, so only the replacement check applies. When Azure's `renew` or GCP's `autoRenew` becomes available, these alerts switch to the softer message automatically, with no change to your settings.

## Idle commitments

The [commitments](./commitments.md) section shows utilization. This alert tells you when it's too low.

**Measured over a window.** Utilization is averaged over the **whole window**, 30 days by default, not judged day by day. A weekday-only workload sits around 71% over a month, above the 70% default, so it doesn't fire every weekend.

**Unknown utilization never alerts.** Utilization shows as **unknown**, not zero, in these cases, and they're skipped so a healthy commitment never looks idle:

- **Unit-based commitments.** A GCP CUD commits vCPUs, and cost data can't say how many of them ran.
- **Accounts where the provider doesn't report commitment coverage.** Without it, a working plan would look unused.
- **Windows with no cost data**, and windows the commitment's term doesn't overlap.
- Any window where the commitment's cost works out to zero.

The window also needs **mostly real data**: by default at least 14 of the 30 days must have cost data. A gap in data collection is never reported as an idle commitment.

**Measured in money.** Each alert shows the wasted amount (what the commitment cost minus what it delivered), and alerts only fire above a money threshold, $50 by default. The alert names the commitment, its utilization, the wasted amount and what you can do: move matching workloads onto it, resize at renewal, or sell it on the provider's marketplace.

Each idle commitment is reported **once per calendar month**.

## Unit-cost regressions

The other alerts can't tell "we're spending more" apart from "we're spending more per customer". This one can.

It divides a [business metric's](./unit-costs.md) cost by the metric's values and compares two back-to-back windows. By default it fires when **cost per unit rises more than 20%**, comparing the last **14 complete days** with the 14 before.

**Missing days are skipped.** A day with no reported metric value is left out of both the cost and the volume. Otherwise a few missed metric uploads would look like a cost regression. A window that's mostly missing days produces no comparison and no alert.

**Enough history.** By default a metric needs **28 days of history, with at least 10 reported days in each 14-day window**. A metric that's only updated twice a month won't fire.

Two more checks:

- The current window's spend must be above a floor, $100 by default.
- A rise from a previous unit cost of exactly **zero** isn't reported. It usually means the earlier spend hadn't arrived yet.

Each currency is judged separately, just like the [unit-cost chart](./unit-costs.md).

After notifying, a metric stays quiet for **14 days**, since a raised unit cost stays raised until it rolls out of both windows. Every firing is still listed, whether it notified or not.

## Unit-cost and margin thresholds

A regression asks "did this go up?". A **threshold** asks "is this over the line?", for example cost per 1,000 requests above $0.40, or gross margin below 30%. You can apply it **per label value**, so each customer is judged on their own margin.

Set thresholds on the metric: **Costs > Unit costs > Edit > Alert thresholds**. Each one has:

| Field           | What it is                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| **Calculation** | Cost per unit, or margin (revenue metrics only).                                                                |
| **Direction**   | Above or below.                                                                                                 |
| **Limit**       | Currency per unit (at the chosen scale) for a unit cost; a percentage for margin.                               |
| **Scale**       | Per unit, hundred, thousand, million or billion.                                                                |
| **Window**      | Trailing complete days the ratio is summed over (1 to 90, default 7).                                           |
| **Per label**   | Judge each value of a label separately. The label must be [mapped to a cost dimension](./unit-costs.md#labels). |

<insert [Business metric editor's Alert thresholds section with two rows: "Margin below 30% over 7 days per customer" and "Cost per 1K request above 0.40 USD over 14 days"] here>

Thresholds are checked once a day, after cost data comes in, using the same numbers as the [unit-cost chart](./unit-costs.md): the window's total spend over its total metric, not the worst single day. A window with fewer than half its days reported isn't judged. The "Other" group in a label split never fires.

A breach fires once and then stays quiet for **7 days** for that threshold, label value and currency. Editing a threshold counts as a new one, so it can fire straight away. Firings appear in the same list as the other alerts on this page, with the observed value next to the limit.

## Manage these alerts

All three are in the **Commitment & unit-cost alerts** section of the Costs panel's **Alerts** tab, on web and desktop. The list shows what fired, when, what it was about and the money involved. Click **Tune alerts** to change the thresholds for all three.

![Costs panel Commitment & unit-cost alerts section showing a mixed list of firings: one commitment expiry with its on-demand exposure, one idle commitment with its wasted amount, one unit-cost regression with its before and after figures](https://agent-assets.infrawrench.com/docs-screenshots/features/commitment-and-unit-cost-alerts/mixed-firings.png)

![The Tune alerts panel expanded, showing all three groups: expiry horizons (60, 30, 7) with the already-expired checkbox, the idle thresholds (70%, 30-day window, 14 measured days, $50 waste floor), and the unit-cost thresholds (20%, 14-day windows, 10 reported days, $100 spend floor)](https://agent-assets.infrawrench.com/docs-screenshots/features/commitment-and-unit-cost-alerts/tune-alerts.png)

You don't need to set anything up. The defaults described above apply from the start.

Viewing needs the `costs:read` permission. Changing thresholds needs `costs:write`, the same as [anomaly tuning](./cost-anomaly-alerts.md), because it changes alerting for the whole organization.

## Notifications

These alerts go through [alert routing](./alert-routing.md) as three trigger kinds: **Commitment expiry**, **Idle commitments** and **Unit-cost alerts** (regressions and thresholds). Routing rules, quiet hours and escalation work just like they do for budgets and anomalies.

The settings panel also has one **Email recipients** list for all three. Everyone on it gets an email each time any of them fires, on top of your routing rules. See [email alerts](./email-alerts.md).

Routing rules can match on the money involved, and each trigger carries the most useful amount:

- Commitment expiry carries the **monthly on-demand exposure**, so a rule like "commitment expiries over $5,000 → #finance" matches on the size of the problem.
- Idle commitments carry the **wasted amount**.
- Unit-cost regressions and thresholds carry the **window's spend**, not the unit cost itself (which is often less than a cent).

Idle commitments use `info` severity, since nothing is breaking. Expiry and unit-cost regressions use `warning`.

Push notifications open the **Alerts** tab of the Costs screen in the [mobile app](./mobile-app.md), where you can view firings. Thresholds are managed on web or desktop.

## API

- `GET /api/org/:orgId/costs/efficiency-alerts`: firings from all three alerts in one feed, newest first, optionally filtered by `kind`. Requires `costs:read`.
- `GET /api/org/:orgId/costs/efficiency-alert-settings`: the thresholds. Requires `costs:read`.
- `PUT /api/org/:orgId/costs/efficiency-alert-settings`: change them. Requires `costs:write`. This replaces the whole settings object rather than patching it.

See the [API reference](../team-and-billing/openapi.md).
