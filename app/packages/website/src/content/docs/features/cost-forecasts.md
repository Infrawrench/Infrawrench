---
title: Cost forecasts
description: A low, expected and high band on every forecast, named forecasts on a cost report that combine scenario models and business-metric plans, and a side-by-side view to compare them.
sidebar_order: 10
---

Every cost forecast in Infrawrench now comes with a **range**, and every [cost report](./cost-reports.md) can hold **named forecasts**: your plan, written down once and compared against what the trend says.

- **Confidence bounds.** The automatic forecast draws a shaded band around its dashed line: a low, an expected and a high value for every projected day and for the period total. Budgets show the same range beside their projected period-end figure.
- **Forecasted business metric values.** A [business metric](./unit-costs.md) can carry planned future values ("1,200 customers in March") separately from what was actually reported.
- **Named forecasts on a report.** Combine a baseline with [scenario models](./scenario-models.md) in priority order, and optionally drive it from a business metric's planned values. One forecast can be the report's default.

## How the range is calculated

The automatic forecast is a straight line fitted through the last 30 days of daily spend (least squares). The band around it is the line's **prediction interval**: how far a day's spend is likely to land from the line, given how far the last 30 days strayed from it.

Three things make it wider:

- **Noisy history.** If spend jumps around a lot from day to day, the band is wide. A perfectly steady history has almost no band.
- **Distance.** The further ahead a day is, the more an error in the slope matters, so the band fans out.
- **Short history.** With only a week or two of data the band uses a wider multiplier (Student's t), because there is less evidence behind the line.

The default range is **80%**: roughly four days in five should land inside it if spend keeps behaving the way it has. The report's Forecasts view, the CLI and the API also offer 90% and 95%.

A period total, such as a budget's month-end figure or a forecast's total over its window, gets its own interval computed from the same fit, rather than by adding up the daily ranges. Adding daily ranges would overstate the uncertainty, because the days share one line. The low end of a period total never drops below what has already been spent in that period.

**The range is an estimate too.** It assumes the day-to-day wobble is random. Real cloud spend has weekday and weekend patterns and step changes, so treat the band as an honest measure of how well a straight line explains your recent spend, not as a guaranteed probability.

<insert [A daily cost graph with a dashed blue trend forecast and a light blue shaded band around it that starts at zero width on the last observed day and widens to the right; tooltip open on a projected day showing "Forecast range (80%)" with a low and high value] here>

On weekly, monthly and quarterly charts the band of each bin is the sum of its days' ranges, which errs on the side of looking less certain rather than more.

### On budgets

A budget card shows its projected period-end total and, next to it, the trend's 80% range ("range $9,200 to $11,400"), with a light shading on the progress bar between the two. Thresholds still fire on the expected figure. For a budget that opted into a scenario model, the range shown is the trend's, labelled "trend range".

## Forecasted business metric values

Open **Costs → Unit costs**, pick a metric and choose **Values**. The **Forecast** tab holds planned values for future days, kept completely apart from the **Reported** actuals:

- they never feed unit costs, unit-cost alerts or coverage figures;
- one value per day, with no labels;
- re-entering a day replaces it.

Add them one day at a time, upload a CSV with **Upload forecast CSV** (the same column mapping as the actuals upload; several rows for the same day are added together), or write them over the API. The chart on the tab draws the reported actuals as a solid line and the forecast as a dashed one.

<insert [The Values dialog for a business metric on the Forecast tab: a small chart with a solid line of reported daily values continuing into a dashed line of planned values, and below it the list of forecasted days with Delete links] here>

## Named forecasts on a report

Open a cost report and scroll to **Forecasts**. The automatic forecast is always listed first. Choose **New forecast** to add your own:

| Field                             | What it does                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Baseline**                      | **Automatic trend**, or **Driven by** a business metric: the report's spend per unit of that metric is projected forward and multiplied by the metric's forecasted values. |
| **Scenario models, in order**     | Pick any number of scenario models and order them. Each one is applied to the line the ones above it produced.                                                             |
| **Show this forecast by default** | The report's default forecast: what its Forecasts view highlights first, what the API returns when no forecast is named, and what `infrawrench costs forecast` prints.     |

Order matters only for organization-wide percentage changes. If a "new team, +$8,000 a month" model comes first and a "migration, −20% everything" model comes second, the migration also takes 20% off the new team. Swap them and the new team's $8,000 stays whole. Inside one model nothing changes: its own adjustments still compose as described in [Scenario models](./scenario-models.md).

Scenario models shift a forecast's range rather than widening it: they are things you say you know, not extra uncertainty.

### Driver metrics

A driven forecast answers "what will this cost if the plan for the business comes true?". Infrawrench divides the report's daily spend by the metric's daily reported value over the last 60 days, fits a trend through that unit cost, and multiplies each future day's projected unit cost by the planned value for that day. Days without a planned value fall back to the trend, and the forecast says how many.

It needs at least 7 days on which the report had spend and the metric had a positive reported value. Without them the forecast shows the trend and a warning.

### Comparing forecasts

The Forecasts view draws every forecast as a line on one chart, with the band of the selected one shaded. Below it, a table compares each forecast's total for the window: expected, the range, and how far it sits from the automatic forecast. Use **Horizon** (30, 90, 180 or 365 days) and **Range** (80%, 90% or 95%) to change the window and the band.

<insert [A cost report's Forecasts section: a chart with the dashed automatic forecast and two coloured named forecast lines, the selected one with a shaded band, and below it a comparison table with Expected, 80% range and vs automatic columns, one row marked Default] here>

Forecasts follow the report: the report's filters, saved filter, cost basis, charge types and billing rules all apply. Everyone who can open the report can see its forecasts; editing them needs edit access to the report and the `costs:write` permission. Forecasts respect [cost visibility scopes](../team-and-billing/cost-visibility.md), so a scoped member's forecast only ever projects the spend they can see.

A scenario model that a forecast uses cannot be deleted until the forecast stops using it, and deleting a report deletes its forecasts.

## On mobile

The [mobile app](./mobile-app.md) draws the band on every cost chart that shows a forecast, shows the range on budget cards, and lists a report's forecasts with their totals and ranges on the report screen. Forecasts are created and edited on web or desktop.

## From the command line

```sh
# The report's default forecast (or the automatic one), next 90 days
infrawrench costs forecast "Platform spend"

# A named forecast, a custom window, narrowed to AWS, at 95%
infrawrench costs forecast "Platform spend" --forecast "EU launch" \
  --from 2026-11-01 --to 2027-01-31 --provider aws --level 95

# Every forecast side by side, as JSON
infrawrench costs forecast "Platform spend" --all --json

# List a report's named forecasts
infrawrench costs forecasts "Platform spend"
```

`infrawrench budgets` also prints the range beside each budget's forecast.

## API

| Method and path                                                          | What it does                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST /api/org/{orgId}/costs/query` with `forecast: true`                | Each forecast point now carries `low` and `high`, plus `forecastConfidenceLevel` |
| `GET /api/org/{orgId}/budgets`                                           | `forecastLowCents` and `forecastHighCents` beside `forecastCents`                |
| `GET /api/org/{orgId}/cost-reports/{id}/forecasts`                       | A report's named forecasts                                                       |
| `POST`, `PUT`, `DELETE` on `/cost-reports/{id}/forecasts[/{forecastId}]` | Create, replace and delete named forecasts                                       |
| `POST /api/org/{orgId}/cost-reports/{id}/forecasted-costs`               | Projected daily spend with bounds for the default, a named, or every forecast    |
| `GET`, `POST`, `DELETE` on `/business-metrics/{id}/forecast-values`      | Read, write and remove a metric's forecasted values                              |

The forecasted-costs body takes `from`, `to` (at most 366 days past the last observed day), `forecastId` (an id, or `"baseline"` for the automatic forecast), `providers` and `services` to narrow the report's scope, `confidenceLevel` (80, 90 or 95) and `all`. The MCP server exposes the same read as `forecast_cost_report`.

## Terraform

Named forecasts are the `infrawrench_cost_forecast` resource in the [Terraform provider](./terraform-provider.md), imported as `<report-id>/<forecast-id>`. Forecasted metric values are data rather than configuration and are not managed by Terraform.
