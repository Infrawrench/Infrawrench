---
title: Unit costs & margin
description: Divide your spend by what your business actually does, such as cost per customer, per request or per GB, and see margin for revenue metrics.
sidebar_order: 3
---

A cost graph tells you whether you're spending more. Unit costs tell you whether you're spending more **per customer**, which is how you tell growth from waste.

To get there, you add a **business metric**: a number only you know, such as active customers, API requests, GB processed or revenue, reported once per day. Point a cost graph at it and the graph shows **cost per unit** instead of plain cost.

> **Cloud only.** Unit costs need the spend collected in Infrawrench Cloud. The desktop app shows them when you're signed into a cloud org. Local-only mode has no spend to divide.

## Quick start

1. Create a metric on the **Costs** panel: its name, its key, and what one of it is called.
2. Give it a value for each day. Import it on a schedule from a connected account, upload a CSV, or send it from a workflow, over the API, or by hand.
3. On any cost graph, pick a **Calculation**: cost per unit, gross margin, cost per usage unit, or the raw metric.

![Costs panel Allocation tab, Unit costs section listing two business metrics, one showing "412 days reported" and one showing "never reported" in amber](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/metrics-list.png)

## Create a metric

Go to **Costs > Unit costs > New metric**.

| Field          | What it is                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Name**       | What people call it, like "Active customers".                                                                            |
| **Key**        | A lowercase slug, like `active-customers`. Workflows, the CLI and the API use this, and it stays the same if you rename. |
| **Unit**       | The singular noun in "USD per customer".                                                                                 |
| **Kind**       | **Count** for a quantity, **Revenue (money)** for money the business took in. Only revenue metrics can show margin.      |
| **Currency**   | Required for revenue metrics, and only for them, because margin subtracts spend from revenue in one currency.            |
| **Cost scope** | Which spend this metric divides. Leave it empty for all spend.                                                           |

![New business metric modal with name, key, unit, kind and the cost scope filter editor visible](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/new-metric-modal.png)

### Set the cost scope

"Cost per customer" only makes sense if the spend is the spend that serves customers. So you set the scope on the metric, using the same filters as graphs and budgets. A graph can **narrow** the scope further but can never widen it.

## Report values

You report one value per UTC day. **Sending a day again replaces it rather than adding to it**, so a nightly job is safe to retry.

### Import on a schedule

Most of these numbers already live somewhere you've connected: a CloudWatch metric, a warehouse table, your billing platform. An **importer** reads them from there on a schedule, so you don't have to push anything.

On a metric's row, choose **Costs > Unit costs > Import…**. Pick a source account, fill in its form, preview, and save.

| Source                                                              | What it reads                                                                                      | Read-only                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Source                                                              | What it reads                                                                                      | Read-only                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [AWS](../plugins/aws.md)                                            | A CloudWatch metric: region, namespace, metric, dimensions and statistic are all pickers           | The API is read-only                                  |
| [GCP](../plugins/gcp.md)                                            | BigQuery SQL, with project, dataset and table pickers and a **Dry run** that reports bytes scanned | Enforced: a dry run checks the statement type first   |
| [Snowflake](../plugins/snowflake.md)                                | Snowflake SQL, with warehouse, role, database and schema pickers                                   | Statement validation; run it under a read-only role   |
| [ClickHouse](../plugins/clickhouse.md)                              | ClickHouse SQL against the account's configured service                                            | Enforced with `readonly=1`                            |
| [PostgreSQL](../plugins/postgres.md) / [MySQL](../plugins/mysql.md) | SQL over the account's connection                                                                  | Enforced: a read-only transaction that is rolled back |
| [Datadog](../plugins/datadog.md)                                    | A Datadog metric: metric, scope and an optional tag to break it down by are pickers, read hourly   | The API is read-only                                  |
| [Metronome](../plugins/metronome.md)                                | Usage of a billable metric, or invoiced revenue, optionally broken down by customer                | The API is read-only                                  |

<insert [Importer modal for a business metric with a BigQuery account selected, the dataset picker open, a SQL query in the editor and the preview table showing 14 days of values] here>

**SQL sources** run one `SELECT` or `WITH` statement that returns a `day` column and a `value` column, plus an optional `label` column for a breakdown. You can use four placeholders, which are filled in as quoted values before the query runs:

```sql
SELECT created_at::date AS day, count(*) AS value
FROM signups
WHERE created_at >= {{from}} AND created_at < {{to_exclusive}}
GROUP BY 1
```

- `{{from}}` and `{{to}}` are the first and last day of the window, inclusive.
- `{{to_exclusive}}` is the day after `{{to}}`.
- `{{timezone}}` is the importer's timezone.

The rest of the form is the same for every source:

| Field                         | What it does                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Schedule**                  | Every 6 or 12 hours, daily (the default) or weekly.                                                                                                                      |
| **Days restated each run**    | How many finished days, ending yesterday, each run reads and replaces. Raise it if the source revises recent days. Today is never imported, since half a day reads low.  |
| **Timezone**                  | Which calendar the days are counted in. Defaults to UTC.                                                                                                                 |
| **Several points on one day** | Sum, average, minimum, maximum, last value or count. This matters for metric sources that return hourly points. A SQL query grouped by day gives one row per day anyway. |

- **Preview** runs the query over the last 14 days and shows what would be saved, without saving anything.
- **Run now** runs the saved importer. Set **From** and **To** to backfill up to 730 days in one run.
- **Run history** keeps the last 50 runs with each failure's message, and the metric's row on the Costs panel shows when the last run failed.

What a run saves:

- Each day the source returns **replaces** what was stored for that day, labels included.
- A day the source returns nothing for is left alone, so it stays a gap rather than becoming zero.
- Points outside the window are ignored.
- Each run is limited to 50,000 rows and two minutes. A run that hits either limit fails and saves nothing.

To set up, preview or run an importer you need `resources:execute` as well as `costs:write`, because the query runs with the account's credentials.

### Upload a CSV

Choose **Upload CSV** on a metric's row. The file has one row per day, or per day and [labels](#labels).

1. Pick the day and value columns and the date format.
2. Tick the **label columns**. Each becomes a label named after its header. Other columns with a usable header are ticked for you.
3. Check the preview and any rows it can't read.
4. Upload.

Uploading a day again replaces it, so you can simply upload a corrected file.

```csv
date,value,customer,plan
2026-08-09,412,acme,enterprise
2026-08-09,96,globex,pro
```

An empty cell in a label column leaves that label off the row. A file without a header can still carry one unnamed breakdown in the **Label column**, saved as the `label` label.

<insert [CSV upload modal with a file selected, the day, value and label columns mapped and the preview table showing the first rows and one unreadable line] here>

### From a workflow

```ts
const rows = await infra.accounts.postgres.prod.query(
  "select count(*) as n from customers where status = 'active'",
);

await infra.businessMetrics.write("active-customers", [{ date: "2026-08-09", value: rows[0].n }]);
```

> Use `infra.businessMetrics`, not `infra.metrics`. That name is for the workflow's own metrics. See [Workflows](./workflows.md).

### Over the API

```bash
curl -X POST \
  "$INFRAWRENCH/api/org/$ORG/business-metrics/active-customers/values" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"values":[{"date":"2026-08-09","value":1204}]}'
```

This needs `costs:write`. The endpoint accepts the metric's key or its id.

### By hand

Click **Values** on a metric's row to see the reported days and type one in. This is handy for checking the metric is set up, and for fixing a bad number: send the day again with the right value.

### Forecasted values

The same dialog has a **Forecast** tab for planned values on future days. Type them in, upload a CSV, or `POST /api/org/{orgId}/business-metrics/{key}/forecast-values` with the same `{"values":[{"date","value"}]}` body. Forecasted values are kept separate from reported ones and never feed a unit cost or an alert. A [named forecast](./cost-forecasts.md#driver-metrics) driven by the metric multiplies its projected cost per unit by them.

## Labels

A value can carry **labels** that break the day down: `customer`, `plan`, `region`, or anything else in your data. One metric can then answer both "how many customers" and "how many enterprise customers in eu-west".

```bash
curl -X POST "$INFRAWRENCH/api/org/$ORG/business-metrics/revenue/values" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"values":[
        {"date":"2026-08-09","value":18200,"labels":{"customer":"acme"}},
        {"date":"2026-08-09","value":4100,"labels":{"customer":"globex"}}
      ]}'
```

From a workflow, pass `labels` on each value of `infra.businessMetrics.write`. You can use up to 8 labels per value, and keys are lowercase slugs like metric keys. An importer's breakdown arrives as a single label called `label` (the same as sending a plain `"label": "acme"` string), so imported and pushed values filter and split the same way.

**Rows add up to the day's total.** A day's total is the sum of every row for that day, labelled or not. Send either the breakdown or the total, never both, or the day counts twice. Sending the same day with the same labels replaces it. The same day with different labels is a separate row.

### Map a label to spend

To see a unit cost or margin **per label value** (cost per customer, margin per customer), the spend has to be split the same way as the volume. A **label mapping** tells Infrawrench where a label's values live on the cost side:

- a **tag** (or virtual tag): label `customer` maps to the `customer` tag, so `customer=acme` divides spend tagged `customer=acme`
- any other **cost dimension** (account, service, region, ...), matched by value
- your org's **cost centres**, matched by centre id or by name (not case-sensitive)

Set mappings in the metric editor under **Label mappings**. The label picker lists the labels your values already carry, and the tag-key picker lists your tags.

<insert [Business metric editor's Label mappings section with "customer" mapped to Tag > customer and "team" mapped to Cost centre] here>

An **unmapped** label can still split or filter the raw metric, but you can't use it in a ratio. Without matching spend per value, Infrawrench would be dividing all your spend by one customer's volume.

![Values modal for a business metric showing recent days with an api/workflow source column and the add-a-day form at the top](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/values-modal.png)

## Chart unit costs

Open any cost graph's editor and pick a **Calculation**. It's a mode of the graph you already have: the date range, binning, filters and cost basis all still apply to the spend side.

| Calculation             | What it shows                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost per unit**       | Spend ÷ the metric.                                                                                                                                                                         |
| **Gross margin**        | `(revenue − spend) ÷ revenue` for a revenue metric, with the absolute margin (revenue − spend) in the headline and tooltip. See [Margin](#margin).                                          |
| **Cost per usage unit** | Spend ÷ the usage quantity your providers report, in one unit (GB-month, vCPU-hour, request). **No business metric needed**: pick the unit from the units your cost data actually includes. |
| **Raw metric**          | The metric itself, with spend on a second axis. Nothing is divided, so a zero here is a real zero.                                                                                          |

Every calculation except margin takes a **scale**: per unit, per hundred, per thousand, per million or per billion. A cost per API request is a string of zeros, while a cost per million requests is a number you can compare. For the raw metric, the scale sets the unit it's shown in ("thousands of requests").

For a metric with labels, two more pickers appear:

- **Split by label** draws one line per label value (the 25 largest by volume, with the rest grouped into "Other").
- **Only label** keeps some values (`plan is enterprise`) or drops them (`plan is not free`).

In a ratio calculation, both pickers list only [mapped labels](#map-a-label-to-spend). Unmapped ones are shown but disabled, with the reason.

<insert [Cost graph config modal with Calculation set to Gross margin, metric Revenue, Split by label set to customer, and the margin-per-customer chart behind it] here>

Four spend-graph options don't apply here, and the editor tells you:

- **Group by** and **Top groups**: use a label split instead, which gives each group its own volume to divide by.
- **Compare** and **Forecast**: these aren't available for ratios.

### Cost per usage unit

Both sides of the ratio come from the **same cost rows**. Only rows reported in the chosen unit count, so "cost per GB-month" divides exactly the spend that bought those GB-months, not your whole bill. A period with no usage in that unit shows as a gap, never zero. Narrow it with the graph's filters (one service, one account) like any other cost graph.

![A unit-cost line chart showing cost per customer over 30 days with a visible break in the line where two days were not reported](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/unit-cost-chart.png)

## Missing days show as gaps, never zero

A period with **no reported metric value** has an unknown unit cost, not a zero one. The chart breaks the line, the CLI prints a dash, the API returns `value: null` with a `gap` reason, and the card says how many periods are affected. Nothing ever shows it as `0`.

A reported value of zero or below is also a gap, since you can't divide by it.

A **real** zero is kept and shown as zero: no spend at all against a real volume really does cost nothing per unit.

### Partly reported periods read high

If you bin weekly but only reported five of the week's seven days, that week divides seven days of spend by five days of volume, so the ratio comes out about 40% too high. Infrawrench still shows it, counts those periods and warns you under the chart. Daily binning avoids the issue.

## How the numbers are calculated

Each period's ratio is that period's **total** spend divided by its **total** metric value:

```
unit cost(period) = Σ spend in period ÷ Σ metric value in period
```

It is never the average of the daily ratios, which would weight a quiet Sunday as heavily as a busy Monday.

The headline figure for the whole range works the same way, across every period that has a value. Periods with no metric value are left out **of both sides**, so missing days never inflate the result.

## Margin

For a metric set to **Revenue (money)**, choose **Margin** instead of **Cost per unit**:

```
margin(period) = (revenue − spend) ÷ revenue
```

It's shown as a percentage, and it goes negative when spend is higher than revenue. The **absolute margin**, `revenue − spend` in the metric's currency, is shown beside it for every period and for the whole range.

Split by a mapped label (say `customer`) and you get each customer's revenue against each customer's spend: margin per customer.

Margin is only available for revenue metrics. The editor and the API both refuse it for a count metric.

## Currency

Spend is converted using your organization's own [stated exchange rates](./cloud-costs.md#currency). Infrawrench never fetches live exchange rates.

- **Unit cost** uses the graph's display currency, just like a spend graph. Currencies you haven't set a rate for aren't dropped. They get their own series, and a note says the series can't be compared with each other.
- **Margin** always converts to the metric's own currency. Spend in a currency with no rate to it shows as a gap on its own series rather than being folded in or ignored, either of which would overstate margin.

## Export the numbers

Hover a unit-cost card and click the download arrow to save what it shows as **CSV** or **NDJSON**. The file matches the chart exactly: same periods, same series. Each row is one period of one series (one per label value when the card is split by a label), and it includes the working as well as the answer:

| Column                                    | What it holds                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `bucket`                                  | The period's first day.                                                                |
| `bucket_days`, `reported_days`            | Days in the period, and days with a reported metric value.                             |
| `partial`                                 | `true` when only some of the period's days were reported, so the ratio reads high.     |
| `label_key`, `label_value`, `label_other` | The label the row is split by, its value, and whether it is the folded "Other" series. |
| `currency`, `mode`, `scale`               | What the ratio is expressed in and per (`scale` 1000 means per 1,000 units).           |
| `metric_key`, `metric_unit`, `usage_unit` | The denominator: a business metric, or a provider usage unit.                          |
| `cost`                                    | Spend summed over the period: the numerator.                                           |
| `metric_value`                            | The metric (or usage) summed over the period, unscaled: the denominator.               |
| `value`                                   | The ratio (or margin fraction), already scaled.                                        |
| `absolute_margin`                         | Margin only: revenue minus spend.                                                      |
| `gap`                                     | Why `value` is empty, when it is.                                                      |

**A gap is an empty cell, never 0**, with the reason in `gap`, so summing or charting the column in a spreadsheet won't invent cheap periods. Text starting with `=`, `+`, `-` or `@` (a label value from your own data, say) gets a `'` in front so a spreadsheet won't run it as a formula.

<insert [A unit-cost card on a dashboard with the download menu open under the arrow button, showing Download CSV and Download NDJSON] here>

You can get the same file from the API with `POST /api/org/{orgId}/business-metrics/{id}/unit-costs/export` (or `…/usage-unit-costs/export`), sending the unit-cost query plus `"format": "csv"` or `"ndjson"`, and from the CLI with `--format` (below). A [cost report's](./cost-reports.md) CSV export adds per-day unit-cost columns when the report shows a unit cost. See [Large exports](./cost-reports.md#large-exports-in-the-background).

## Use the CLI

The command is `unit-costs`, not `metrics` (that one charts a resource's provider metrics).

````bash
```bash
# The org's business metrics, and how well each is being reported.
infrawrench unit-costs

# Cost per unit over the last 90 days, weekly.
infrawrench unit-costs active-customers --last 90d --group-by weekly

# Margin, on a revenue metric.
infrawrench unit-costs mrr --margin --last 12w

# Everything, as JSON.
infrawrench unit-costs active-customers --json

# Accounts that can feed a metric, and the fields each importer takes.
infrawrench unit-costs sources

# Configure, inspect and run an importer.
infrawrench unit-costs importer api-requests set --account prod-aws \
  --set namespace=AWS/ApplicationELB --set metricName=RequestCount --set stat=Sum
infrawrench unit-costs importer signups set --account warehouse --set sql=@signups.sql
infrawrench unit-costs importer signups              # config and recent runs
infrawrench unit-costs importer signups run --from 2025-10-01 --to 2026-09-30
infrawrench unit-costs importer signups disable

# Cost per 1,000 requests.
infrawrench unit-costs api-requests --scale 1k

# Margin per customer (needs `customer` mapped on the metric), only enterprise plans.
infrawrench unit-costs revenue --margin --split customer --label plan=enterprise

# The raw metric, split by region.
infrawrench unit-costs active-customers --mode raw --split region

# The metric's labels and what each maps to.
infrawrench unit-costs revenue --labels

# Cost per provider usage unit: list the units, then divide by one.
infrawrench unit-costs --usage-units
infrawrench unit-costs --usage-unit GB-Mo --where "service = 'AmazonS3'"

# The series as a file, with the spend and metric value behind each ratio.
infrawrench unit-costs api-requests --scale 1k --format csv > api-requests.csv
infrawrench unit-costs revenue --margin --split customer --format ndjson > margin.ndjson
````

```

`--label key=a,b` keeps those values and `--label key!=a` drops them. Repeat it for several labels. A `--split` prints one summary row per label value with a trend sparkline, and `--json` includes every point.

Unreported periods print as a dash in the table, with the reason in the last column. See [CLI](./cli.md).

## Ask AI instead

The MCP server and the in-app chat include these tools:

- `list_business_metrics`, `get_business_metric_values`, `list_business_metric_labels`, `list_usage_units`
- `query_unit_costs`, covering every calculation, scale, label split and filter above
- the metric write tools (labels included)
- the importer tools: `list_business_metric_sources`, `list_business_metric_source_options`, `preview_business_metric_import`, `get_business_metric_importer`, `set_business_metric_importer`, `run_business_metric_importer`, `delete_business_metric_importer`

So you can ask "what did a customer cost us last month, and is that up or down?" without building a graph. The tools follow the same gap rules, so a summary won't turn a missing day into a zero. See [MCP](./mcp.md) and [AI chat](./ai-chat.md).

## Get alerted

A **unit-cost regression** alert fires when cost per unit rises more than 20% compared with the previous fortnight. This catches what a spend alert can't: spend going up while cost per customer goes down is good news. Days with no reported value are left out, and a window that's mostly gaps produces no alert. A metric needs at least 10 reported days in each of the two 14-day windows before it can fire.

You can also set **thresholds** on a metric: alert when cost per unit goes above a limit, or margin drops below one, over a trailing window and optionally per label value (margin per customer below 30%). See [Commitment & unit-cost alerts](./commitment-and-unit-cost-alerts.md).

## Manage metrics as code

In the [Terraform provider](./terraform-provider.md), `infrawrench_business_metric` manages the metric definition, including `label_mapping` and `threshold` blocks. `infrawrench_cost_report` supports every calculation field (`unit_cost_mode`, `unit_cost_scale`, `unit_cost_usage_unit`, `unit_cost_group_by_label`, `unit_cost_label_filter`). Values aren't managed in Terraform, since they're a time series rather than configuration.

## On your phone

The [mobile app](./mobile-app.md)'s **Costs** tab shows a read-only card per metric: the last 30 days, the period figure (gross margin with the absolute margin beside it, for a revenue metric), and a sparkline that **breaks on a gap** rather than bridging it. Each card also shows what imports the metric and whether its last run failed. To create metrics, set up importers or report values, use the web or desktop app.

## Permissions

Reading metrics and unit costs needs `costs:read`. Creating, editing and deleting metrics, and reporting values, need `costs:write`, the same as [saved filters](./cloud-costs.md#saved-filters). Every change is recorded in the [audit log](../team-and-billing/audit-log.md), including how many days a batch of values replaced.

## Delete a metric

You can always delete a metric. Any cost card that divides by it will then show an error rather than quietly switching back to plain spend.
```
