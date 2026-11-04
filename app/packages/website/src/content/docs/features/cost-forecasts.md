---
title: Cost forecasts
description: See a low, expected and high range on every cost forecast, build named forecasts on a cost report from scenario models and business-metric plans, and compare them side by side.
sidebar_order: 10
---

Cost forecasts show you where spend is heading, with a range so you know how sure the estimate is. On any [cost report](./cost-reports.md) you can also write down your own plan as a **named forecast** and compare it with what the trend says.

- **Forecast ranges.** The automatic forecast draws a shaded band around its dashed line, with a low, expected and high value for every future day and for the period total. Budgets show the same range next to their projected period-end figure.
- **Planned business metric values.** A [business metric](./unit-costs.md) can hold planned future values ("1,200 customers in March"), kept separate from what was actually reported.
- **Named forecasts on a report.** Combine a baseline with [scenario models](./scenario-models.md) in the order you choose, and optionally drive it from a business metric's planned values. One forecast can be the report's default.

## Read the forecast range

The automatic forecast is a straight trend line through your last 30 days of daily spend. The band around it shows how far a day's spend is likely to land from that line, based on how far your recent spend strayed from it.

The band gets wider when:

- **Your spend is noisy.** If spend jumps around from day to day, the band is wide. Very steady spend has almost no band.
- **You look further ahead.** The band fans out the further into the future you go.
- **You have little history.** With only a week or two of data, the band is wider because there's less evidence behind the line.

The default range is **80%**: roughly four days in five should land inside it if spend keeps behaving as it has. The report's Forecasts view, the CLI and the API also offer 90% and 95%.

A period total (like a budget's month-end figure) gets its own range, which is narrower than adding up the daily ranges. Its low end never drops below what you've already spent in that period.

**Treat the range as a guide.** Real cloud spend has weekday and weekend patterns and sudden step changes, so the band tells you how well a straight line explains your recent spend. It isn't a guaranteed probability.

<insert [A daily cost graph with a dashed blue trend forecast and a light blue shaded band around it that starts at zero width on the last observed day and widens to the right; tooltip open on a projected day showing "Forecast range (80%)" with a low and high value] here>

On weekly, monthly and quarterly charts, each bar's band adds up its days' ranges, so it looks less certain rather than more.

### On budgets

A budget card shows its projected period-end total with the trend's 80% range next to it ("range $9,200 to $11,400"), and a light shading on the progress bar between the two. Thresholds still fire on the expected figure. If a budget uses a scenario model, the range shown is the trend's and is labelled "trend range".

## Add planned business metric values

1. Open **Costs > Unit costs**, pick a metric and choose **Values**.
2. Go to the **Forecast** tab.
3. Add planned values one day at a time, or upload a CSV with **Upload forecast CSV**. You can also write them through the API.

How planned values behave:

- They're kept completely apart from the **Reported** actuals, and never feed unit costs, unit-cost alerts or coverage figures.
- There's one value per day, with no labels. Entering a day again replaces it.
- The CSV upload uses the same column mapping as the actuals upload. Several rows for the same day are added together.

The chart on the tab shows reported actuals as a solid line and the forecast as a dashed one.

<insert [The Values dialog for a business metric on the Forecast tab: a small chart with a solid line of reported daily values continuing into a dashed line of planned values, and below it the list of forecasted days with Delete links] here>

## Create a named forecast

Open a cost report and scroll to **Forecasts**. The automatic forecast is always listed first. Choose **New forecast** to add your own:

| Field                             | What it does                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Baseline**                      | **Automatic trend**, or **Driven by** a business metric: the report's spend per unit of that metric is projected forward and multiplied by the metric's planned values.                    |
| **Scenario models, in order**     | Pick any number of scenario models and put them in order. Each one is applied on top of the result of the ones above it.                                                                   |
| **Show this forecast by default** | Makes this the report's default forecast: the one its Forecasts view highlights first, the one the API returns when no forecast is named, and the one `infrawrench costs forecast` prints. |

Order only matters for organization-wide percentage changes. If a "new team, +$8,000 a month" model comes first and a "migration, −20% everything" model comes second, the migration also takes 20% off the new team. Swap them and the new team's $8,000 stays whole. Within a single model nothing changes: its adjustments still combine as described in [Scenario models](./scenario-models.md).

Scenario models move a forecast's range rather than widening it, because they're things you know, not extra uncertainty.

### Driver metrics

A driven forecast answers "what will this cost if our business plan comes true?". Infrawrench works out the report's daily spend per unit of the metric over the last 60 days, projects that unit cost forward, and multiplies it by your planned value for each future day. Days without a planned value fall back to the trend, and the forecast tells you how many there are.

You need at least 7 days on which the report had spend and the metric had a positive reported value. Without them, the forecast shows the trend and a warning.

### Compare forecasts

The Forecasts view draws every forecast as a line on one chart, with the selected one's band shaded. Below it, a table compares each forecast's total for the window: the expected figure, the range, and how far it is from the automatic forecast. Use **Horizon** (30, 90, 180 or 365 days) and **Range** (80%, 90% or 95%) to change the window and the band.

<insert [A cost report's Forecasts section: a chart with the dashed automatic forecast and two coloured named forecast lines, the selected one with a shaded band, and below it a comparison table with Expected, 80% range and vs automatic columns, one row marked Default] here>

### Who can see and edit forecasts

- Forecasts follow the report: its filters, saved filter, cost basis, charge types and billing rules all apply.
- Anyone who can open the report can see its forecasts. Editing them needs edit access to the report and the `costs:write` permission.
- Forecasts respect [cost visibility scopes](../team-and-billing/cost-visibility.md), so a scoped member's forecast only ever projects the spend they can see.
- You can't delete a scenario model while a forecast uses it. Deleting a report deletes its forecasts.

## On mobile

The [mobile app](./mobile-app.md) shows the band on every cost chart with a forecast, shows the range on budget cards, and lists a report's forecasts with their totals and ranges on the report screen. Create and edit forecasts on web or desktop.

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

`infrawrench budgets` also prints the range next to each budget's forecast.

## API

| Method and path                                                          | What it does                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `POST /api/org/{orgId}/costs/query` with `forecast: true`                | Each forecast point carries `low` and `high`, plus `forecastConfidenceLevel`  |
| `GET /api/org/{orgId}/budgets`                                           | `forecastLowCents` and `forecastHighCents` beside `forecastCents`             |
| `GET /api/org/{orgId}/cost-reports/{id}/forecasts`                       | A report's named forecasts                                                    |
| `POST`, `PUT`, `DELETE` on `/cost-reports/{id}/forecasts[/{forecastId}]` | Create, replace and delete named forecasts                                    |
| `POST /api/org/{orgId}/cost-reports/{id}/forecasted-costs`               | Projected daily spend with ranges for the default, a named, or every forecast |
| `GET`, `POST`, `DELETE` on `/business-metrics/{id}/forecast-values`      | Read, write and remove a metric's planned values                              |

The forecasted-costs body takes:

- `from` and `to` (at most 366 days past the last day with data)
- `forecastId` (an id, or `"baseline"` for the automatic forecast)
- `providers` and `services` to narrow the report's scope
- `confidenceLevel` (80, 90 or 95)
- `all`

The MCP server offers the same read as `forecast_cost_report`.

## Terraform

Named forecasts are the `infrawrench_cost_forecast` resource in the [Terraform provider](./terraform-provider.md), imported as `<report-id>/<forecast-id>`. Planned metric values are data, not configuration, so Terraform doesn't manage them.
