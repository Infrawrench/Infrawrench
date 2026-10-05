---
title: Unit costs & margin
description: Divide your spend by the thing your business actually does — cost per customer, per request, per GB — and, for revenue metrics, margin.
sidebar_order: 3
---

A cost graph answers "are we spending more". It cannot answer "are we spending more **per customer**", and that is the question that decides whether a rising bill is growth or waste.

A **business metric** is the missing half: a number only you know — active customers, API requests, GB processed, revenue — reported once per day. Point a cost graph at one and it draws **cost per unit** instead of cost.

> **Cloud only.** Unit costs divide collected spend, which lives in Infrawrench Cloud's cost store. The desktop app shows them when you are signed into a cloud org; local-only mode has no spend to divide.

## The short version

1. Declare a metric on the **Costs** panel — its name, its key, and what one of it is called.
2. Feed it a value for each day: import it on a schedule from a connected account, upload a CSV, or report it from a workflow, over the API, or by hand.
3. On any cost graph, pick a **Calculation**: cost per unit, gross margin, cost per usage unit, or the raw metric.

![Costs panel Unit costs section listing two business metrics, one showing "412 days reported" and one showing "never reported" in amber](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/metrics-list.png)

## Declare a metric

**Costs → Unit costs → New metric.**

| Field          | What it is                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Name**       | What people call it — "Active customers".                                                                                     |
| **Key**        | A lowercase slug — `active-customers`. This is what workflows, the CLI and the API address it by, and it survives a rename.   |
| **Unit**       | The singular noun in "USD per customer".                                                                                      |
| **Kind**       | **Count** for a quantity, **Revenue (money)** for money the business took in. Only a revenue metric can have margin computed. |
| **Currency**   | Revenue metrics only, and required for them — margin subtracts spend from revenue, which is only defined in one currency.     |
| **Cost scope** | Which spend this metric divides. Empty means all of it.                                                                       |

![New business metric modal with name, key, unit, kind and the cost scope filter editor visible](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/new-metric-modal.png)

### Cost scope is part of what the metric means

"Cost per customer" is only honest if the numerator is the spend that serves customers. So the scope lives on the metric, in the same filter vocabulary graphs and budgets use, and a graph can **narrow** it further but never widen it. A graph that could drop the scope would be answering a different question under the same name.

## Report values

One value per UTC day. **Re-reporting a day replaces it rather than adding to it**, so a nightly job is safe to retry — an ingest that accumulated would double every number the first time the job re-ran, and nothing about the resulting chart would look wrong.

### Import on a schedule

Most of these numbers already live somewhere you have connected: a CloudWatch metric, a table in your warehouse, your billing platform. An **importer** reads them from there on a schedule, so nothing has to push.

**Costs → Unit costs → Import…** on a metric's row. Pick a source account, fill in its form, preview, save.

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

**SQL sources** run one `SELECT` or `WITH` statement that returns a `day` column and a `value` column, plus an optional `label` column for a breakdown. Four placeholders are replaced with quoted literals before the query runs:

```sql
SELECT created_at::date AS day, count(*) AS value
FROM signups
WHERE created_at >= {{from}} AND created_at < {{to_exclusive}}
GROUP BY 1
```

`{{from}}` and `{{to}}` are the first and last day of the window, inclusive; `{{to_exclusive}}` is the day after `{{to}}`; `{{timezone}}` is the importer's timezone.

The rest of the form is the same for every source:

| Field                         | What it does                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schedule**                  | Every 6 or 12 hours, daily (the default) or weekly.                                                                                                                          |
| **Days restated each run**    | How many closed days, ending yesterday, each run reads and restates. Raise it when the source revises recent days. Today is never imported: half a day reads as a low value. |
| **Timezone**                  | Which calendar the days are counted in. Defaults to UTC.                                                                                                                     |
| **Several points on one day** | Sum, average, minimum, maximum, last value or count. Matters for metric sources that return hourly points; a SQL query grouped by day gives one row per day anyway.          |

**Preview** runs the query over the last 14 days and shows what would be written, writing nothing. **Run now** runs the saved importer; set **From** and **To** to backfill up to 730 days in one run. The **run history** keeps the last 50 runs with each failure's message, and the metric's row on the Costs panel says when the last run failed.

How a run writes: each day the source returns **replaces** what was stored for that day, every label included. A day the source returns nothing for is left alone, so it stays a gap rather than becoming zero. Points outside the window are ignored. Every run has a 50,000-row limit and a two-minute timeout, and a run that hits either fails without writing anything.

Configuring, previewing and running an importer needs `resources:execute` as well as `costs:write`, because the query runs with the account's credentials.

### Upload a CSV

**Upload CSV** on a metric's row takes a file with one row per day, or per day and [labels](#labels). Pick the day and value columns and the date format, tick the **label columns** (each becomes a label named after its header; every other column with a usable header is ticked for you), check the preview and the rows it cannot read, then upload. Uploading a day again replaces it, so a corrected file can simply be uploaded again.

```csv
date,value,customer,plan
2026-08-09,412,acme,enterprise
2026-08-09,96,globex,pro
```

An empty cell in a label column leaves that label off the row. A file without a header can still carry one unnamed breakdown in the **Label column**, stored as the `label` label.

<insert [CSV upload modal with a file selected, the day, value and label columns mapped and the preview table showing the first rows and one unreadable line] here>

### From a workflow

```ts
const rows = await infra.accounts.postgres.prod.query(
  "select count(*) as n from customers where status = 'active'",
);

await infra.businessMetrics.write("active-customers", [{ date: "2026-08-09", value: rows[0].n }]);
```

> It is `infra.businessMetrics`, not `infra.metrics` — that name already belongs to the workflow's own declared metrics. See [Workflows](./workflows.md).

### Over the API

```bash
curl -X POST \
  "$INFRAWRENCH/api/org/$ORG/business-metrics/active-customers/values" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"values":[{"date":"2026-08-09","value":1204}]}'
```

Needs `costs:write`. The endpoint accepts the metric's key or its id.

### By hand

**Values** on a metric's row opens the reported days and lets you type one in. This is mostly for confirming the metric is wired up at all, and for correcting a bad number — send the day again with the right value.

## Labels

A value can carry **labels** that break the day down: `customer`, `plan`, `region`, or anything else your data has. One metric then answers "how many customers" and "how many enterprise customers in eu-west" at once.

```bash
curl -X POST "$INFRAWRENCH/api/org/$ORG/business-metrics/revenue/values" \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" -H "Content-Type: application/json" \
  -d '{"values":[
        {"date":"2026-08-09","value":18200,"labels":{"customer":"acme"}},
        {"date":"2026-08-09","value":4100,"labels":{"customer":"globex"}}
      ]}'
```

From a workflow, pass `labels` on each value of `infra.businessMetrics.write`. Up to 8 labels per value; keys are lowercase slugs like metric keys. A scheduled importer's breakdown arrives as the single label `label` (a value sent with a plain `"label": "acme"` string is the same thing), so imported and pushed values filter and split alike.

**Rows partition the metric.** A day's total is the sum of every row for that day, labelled or not. Report either the breakdown or the total, never both, or the day counts twice. The same day with the same labels restates; the same day with different labels is a separate row.

### Mapping a label to spend

To compute a unit cost or margin **per label value** (cost per customer, margin per customer) the spend has to be split the same way as the volume. A **label mapping** says where a label's values live on the cost side:

- a **tag** (or virtual tag): label `customer` maps to the `customer` tag, so `customer=acme` divides spend tagged `customer=acme`;
- any other **cost dimension** (account, service, region, ...), matched by value;
- the org's **cost centres**, matched by centre id or (case-insensitively) by name.

Set mappings in the metric editor under **Label mappings**; the label picker lists the labels your values already carry, and the tag-key picker lists your own tags.

<insert [Business metric editor's Label mappings section with "customer" mapped to Tag → customer and "team" mapped to Cost centre] here>

An **unmapped** label can still split or filter the raw metric, but a ratio refuses it: without a per-value numerator the only spend available is the whole scope's, and dividing that by one customer's volume gives a number per customer that sums to nothing.

![Values modal for a business metric showing recent days with an api/workflow source column and the add-a-day form at the top](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/values-modal.png)

## Draw it

Open any cost graph's editor and pick a **Calculation**. It is a mode of the graph you already have, not a different chart: the date range, the binning, the filters and the cost basis all still describe the spend side.

| Calculation             | What it draws                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost per unit**       | Spend ÷ the metric.                                                                                                                                                                                |
| **Gross margin**        | `(revenue − spend) ÷ revenue` for a revenue metric, with the absolute margin (revenue − spend) in the headline and tooltip. See [Margin](#margin).                                                 |
| **Cost per usage unit** | Spend ÷ the usage quantity your providers report, in one unit (GB-month, vCPU-hour, request). **No business metric needed**: pick the unit from the list of units your cost data actually carries. |
| **Raw metric**          | The metric itself, with spend on a second axis. Nothing is divided, so a zero is a real zero here.                                                                                                 |

Every calculation except margin takes a **scale**: per unit, per hundred, per thousand, per million or per billion. A cost per API request is a string of zeros; a cost per million requests is a number you can compare. For the raw metric the scale sets the unit it is shown in ("thousands of requests").

For a metric with labels, two more pickers appear:

- **Split by label** draws one line per label value (the 25 largest by volume; the rest fold into "Other").
- **Only label** keeps some values (`plan is enterprise`) or drops them (`plan is not free`).

In a ratio calculation both list only [mapped labels](#mapping-a-label-to-spend); unmapped ones are shown but disabled, with the reason.

<insert [Cost graph config modal with Calculation set to Gross margin, metric Revenue, Split by label set to customer, and the margin-per-customer chart behind it] here>

Four spend-graph options stop applying, and the editor says so:

- **Group by** and **Top groups** — a per-group ratio needs a per-group denominator, which is what a label split gives you instead. Dividing each service's spend by the whole customer count gives five numbers that do not sum to the real one.
- **Compare** and **Forecast** — projecting a ratio means projecting two independent series and dividing, which is a different thing from projecting one.

### Cost per usage unit

The numerator and the denominator come from the **same cost rows**: only rows reported in the chosen unit count on either side, so "cost per GB-month" divides exactly the spend that bought those GB-months, not your whole bill. A period with no usage in that unit is a gap, never zero. Narrow it with the graph's filters (one service, one account) like any other cost graph.

![A unit-cost line chart showing cost per customer over 30 days with a visible break in the line where two days were not reported](https://agent-assets.infrawrench.com/docs-screenshots/features/unit-costs/unit-cost-chart.png)

## Gaps are gaps, never zero

This is the rule the whole feature stands on.

A period with **no reported metric value** has an unknown unit cost, not a zero one. The chart breaks the line, the CLI prints `—`, the API returns `value: null` with a `gap` reason, and the card says how many periods are affected. Nothing anywhere renders it as `0`.

The same applies to a value of zero or below: you cannot divide by it, so it is a gap too.

A **genuine** zero is kept and shown as zero: no spend at all over a real denominator really does cost nothing per unit.

### Partly reported periods read high

If you bin weekly but only reported five of the week's seven days, the week has seven days of spend over five days of volume, and the ratio comes out about 40% too high. Infrawrench still computes it — throwing away five real days of data is its own distortion — but counts those periods and warns under the chart. Daily binning makes the question moot.

## The arithmetic

Each period's ratio is that period's **summed** spend over its **summed** metric value:

```
unit cost(period) = Σ spend in period ÷ Σ metric value in period
```

Never the average of the daily ratios. On a week where volume moved, the two are different numbers, and the average is the wrong one — it weights a quiet Sunday exactly as heavily as a peak Monday.

The headline figure over the whole range works the same way: summed numerator over summed denominator, across every period that produced a ratio. Periods with no denominator are excluded **from both sides** — folding their spend into the numerator while their volume is missing from the denominator would inflate the answer silently.

## Margin

For a metric declared **Revenue (money)**, choose **Margin** instead of **Cost per unit**:

```
margin(period) = (revenue − spend) ÷ revenue
```

It is a fraction, shown as a percentage, and it goes negative when spend exceeds revenue rather than clamping at zero. The **absolute margin**, `revenue − spend` in the metric's currency, is reported beside it on every period and for the whole range.

Split by a mapped label (say `customer`), margin becomes each customer's revenue against each customer's spend: the margin per customer.

Margin is offered only for revenue metrics. Against a count metric it would subtract dollars from requests and divide by requests — a number that computes cleanly and means nothing — so both the editor and the API refuse it.

## Currency

Spend is converted to the metric's terms through your organization's own [stated exchange rates](./cloud-costs.md#currency). Infrawrench never fetches live FX.

- **Unit cost** follows the graph's display currency, exactly like a spend graph. Currencies you have stated no rate for are not dropped — they keep their own series, dividing the same metric on their own, and the caveat line says the series are not comparable to each other.
- **Margin** always converts to the metric's own currency, because subtracting spend from revenue is only defined in one. Spend in a currency with no rate to it becomes a gap on its own series rather than being quietly folded in or ignored — either of which would overstate margin.

## From the CLI

The verb is `unit-costs`, not `metrics` — that one already charts a resource's provider metrics.

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
```

`--label key=a,b` keeps those values and `--label key!=a` drops them; repeat it for several labels. A `--split` prints one summary row per label value with a trend sparkline; `--json` carries every point.

Unreported periods print as `—` in the table, with the reason in the last column. See [CLI](./cli.md).

## Ask the model instead

The MCP server and the in-app chat expose `list_business_metrics`, `get_business_metric_values`, `list_business_metric_labels`, `list_usage_units`, `query_unit_costs` (every calculation, scale, label split and filter above), the metric write tools (labels included), and the importer tools (`list_business_metric_sources`, `list_business_metric_source_options`, `preview_business_metric_import`, `get_business_metric_importer`, `set_business_metric_importer`, `run_business_metric_importer`, `delete_business_metric_importer`), so "what did a customer cost us last month, and is that up or down?" works without building a graph. The tool descriptions carry the gap rule and the summed-sides rule explicitly, so a model summarising the data does not turn a gap into a zero. See [MCP](./mcp.md) and [AI chat](./ai-chat.md).

## Being told, rather than looking

A **unit-cost regression** alert fires when cost per unit rises more than 20% against the prior
fortnight — the business signal a spend-versus-spend alert cannot see, because spend rising
while cost-per-customer falls is good news. The gap rule above carries straight through: a day
with no reported value contributes to neither side, and a window that is mostly gaps produces no
comparison at all rather than an invented regression. A metric needs at least 10 reported days
in each of the two 14-day windows before it can fire.

You can also set **thresholds** on a metric: alert when cost per unit goes above a limit, or margin
drops below one, over a trailing window and optionally per label value (margin per customer
below 30%). See [Commitment & unit-cost alerts](./commitment-and-unit-cost-alerts.md).

## As code

The [Terraform provider](./terraform-provider.md)'s `infrawrench_business_metric` manages the
definition, including `label_mapping` and `threshold` blocks, and `infrawrench_cost_report`
carries every calculation field (`unit_cost_mode`, `unit_cost_scale`, `unit_cost_usage_unit`,
`unit_cost_group_by_label`, `unit_cost_label_filter`). Values stay out of Terraform: they are a
time series, not configuration.

## On your phone

The [mobile app](./mobile-app.md)'s **Costs** tab shows a read-only card per metric: the trailing 30 days, the period figure (gross margin with the absolute margin beside it, for a revenue metric), and a sparkline that **breaks on a gap** rather than bridging it. Each card also says what imports the metric and whether its last run failed. Declaring metrics, configuring importers and reporting values stay on web and desktop — both are finance-governance acts needing `costs:write` and the full cost-filter editor, the same deliberate omission as the tag policy and exchange rates.

## Permissions

Reading metrics and unit costs needs `costs:read`. Creating, editing, deleting a metric and reporting values need `costs:write` — the same permissions as [saved filters](./cloud-costs.md#saved-filters) and pushed cost rows. Every write is recorded in the [audit log](../team-and-billing/audit-log.md), including how many days a value batch restated.

## Deleting a metric

Deleting is refused by nothing — but any cost card dividing by that metric will show an error rather than quietly reverting to plain spend. That is deliberate: a chart that silently changed what it measures is worse than one that says it is broken.
