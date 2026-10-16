---
title: Commitment reports
description: Saved reports on how reserved instances, savings plans and committed-use discounts performed over time, with coverage, utilization, savings and waste per day, week, month or quarter.
sidebar_order: 15
---

The [Commitments](./commitments.md) section answers "how are our commitments doing right now", over a fixed trailing window. A **commitment report** answers the question over time and keeps it under a name: "how did our savings plans do each week this quarter, per account", "what did the EC2 reservations waste last month", "how much of our Azure usage is covered, month by month".

Reports live on the Costs page's **Commitments & credits** tab, under **Commitment reports**. They file into the same folders as [cost reports](./cost-reports.md) and are shared the same way.

<insert [The Commitment reports section on the Commitments & credits tab: a list of three saved reports, two at the top level and one under a "FinOps" folder heading, each showing its chart metric, granularity and grouping] here>

## Creating a report

Click **New report** and choose:

- **Name**, an optional **description**, and a **folder** (the cost report folders; create and rename them under Reports).
- **Date range**: a relative window (last 30 or 90 days, month to date, last 12 months, and so on) that moves with every run, or custom fixed dates.
- **Granularity**: daily, weekly (weeks start on Monday), monthly or quarterly. A daily report covers at most 366 days; any report at most 1096.
- **Group by**: provider, commitment type, commitment, service, account or region, or no grouping.
- **Chart metric**: the metric the chart draws. The table always shows every metric.
- **Filters**: providers, commitment types, accounts, services, regions and specific commitments, each picked from what your org actually has.

<insert [The New commitment report dialog with "Last 90 days", "Weekly" and "Group by: Commitment type" selected, the chart metric set to Utilization, and the Providers filter open showing AWS and Azure, with GCP listed as "holdings only, not measurable"] here>

### Why there is no hourly option

Spend is collected one row per day per provider, account, service and region. An hourly bucket would put each day's spend at midnight and draw 23 empty hours, so it is not offered. Days are the finest grain the data has.

## Reading a report

Opening a report shows which providers were measured, any notices, a headline row per currency, a chart of the chosen metric over time, and a table with every metric (per period without grouping, per group otherwise, with a total row).

<insert [An open commitment report: the headline tiles (Coverage "62.0% to 78.4%", Utilization 91.3%, Effective savings rate 18.2%, Net savings $41,200, On-demand remainder $96,500, Commitment cost $187,000 with "$170,700 used, $16,300 unused" underneath), a weekly utilization line chart with one line per commitment type, and the metrics table below] here>

A dash means there was nothing to measure in that bucket, never zero: a week with no usage was not 0% covered, it had nothing to cover. A gap in the chart is drawn as a gap for the same reason.

Amounts are never added across currencies. An org billed in two currencies gets one headline and one set of lines per currency.

## The metrics

Every metric is computed on the **amortized** basis, the same basis as the Commitments section's coverage and utilization, and for the same reason: AWS and Azure price the usage a commitment covered at zero cash (it was paid for when the commitment was bought), so a cash ratio would read 0% for every org that has ever committed to anything.

For each bucket, five amounts are read from your cost data:

| Amount                   | What it is                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Covered**              | Usage a commitment covered, at its amortized (effective) cost. This is commitment money that bought something.                                          |
| **Unused**               | Commitment fees no usage absorbed: AWS's amortized RI fee and savings plan recurring fee, Azure's unused reservation and unused savings plan charges.   |
| **Uncovered**            | Usage no commitment covered, billed on demand.                                                                                                          |
| **Uncovered, eligible**  | Uncovered usage in provider, service and region combinations where a commitment covered something during the window.                                    |
| **On-demand equivalent** | What the covered usage would have cost on demand at your own rates, where the provider reports it (see [Savings](#savings-are-measured-not-estimated)). |

From those:

| Metric                         | Definition                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Coverage**                   | covered ÷ (covered + uncovered). The lower bound: it counts usage no commitment could ever cover, such as egress. |
| **Coverage of eligible usage** | covered ÷ (covered + eligible uncovered). The upper bound. The headline shows coverage as this range.             |
| **Utilization**                | used ÷ (used + unused): the share of what you committed to that paid for usage.                                   |
| **Used commitment cost**       | covered.                                                                                                          |
| **Unused commitment cost**     | unused: money that bought nothing.                                                                                |
| **Commitment cost**            | used + unused.                                                                                                    |
| **On-demand remainder**        | uncovered.                                                                                                        |
| **Net savings vs on-demand**   | (on-demand equivalent − covered) − unused. Negative when waste outweighs the discount.                            |
| **Effective savings rate**     | net savings ÷ (on-demand equivalent + uncovered): the discount you achieved across all of this usage.             |

A ratio whose denominator is zero is shown as a dash. These definitions live in one shared function used by the server, the web and desktop apps, mobile and the CLI, so every surface prints the same number.

### Grouping by commitment or commitment type

Grouping by **commitment** or **commitment type** splits the commitment side (covered usage and unused fees) by holding, and puts uncovered usage in its own **On demand (not covered)** row. Each group's coverage is then its share of _all_ the bucket's usage, so the groups add up to the total. Utilization and savings stay per holding.

A **commitment type** or **commitment** filter narrows the commitment side the same way: coverage then reads "share of all usage these commitments covered", and uncovered usage stays in the denominator.

### Instance family

Instance family is not offered as a grouping: no provider's cost collection stores it on cost rows today, so a split by it could only be invented. Each holding's own scope (an instance family, for an EC2 Instance Savings Plan) is shown in the commitments inventory.

## What each provider supports

| Provider  | Coverage, utilization, waste                                                  | Savings                                         | By specific commitment                                        |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| **AWS**   | Yes                                                                           | Yes, from collection after this feature shipped | No: Cost Explorer cannot group by reservation or plan         |
| **Azure** | Yes, where the subscription returns the amortized dataset (not pay-as-you-go) | Yes, from collection after this feature shipped | On Enterprise Agreement and Microsoft Customer Agreement only |
| **GCP**   | No: its cost collection does not yet separate covered from uncovered usage    | No                                              | No                                                            |

GCP committed-use discounts still appear in the [inventory](./commitments.md), and a report names GCP as **not measured** rather than reading its usage as 0% covered. The same applies to every other provider whose commitments are listed but whose cost data has no coverage signal (Oracle Cloud, Crusoe and RunPod today).

Covered usage that the provider cannot tie to a specific commitment (all of AWS) appears in a **Covered, commitment not reported** group when you group by commitment or commitment type, and matches no commitment or commitment type filter.

### AWS utilization is monthly

In AWS's daily amortized data, the unused part of a month's commitment fee is booked on the first day of the month (or on the purchase day), not spread across the days it was unused. Daily and weekly AWS utilization therefore dip on the 1st. A report that includes AWS at daily or weekly granularity says so; use monthly granularity for AWS utilization and waste.

### Savings are measured, not estimated

Savings need what the covered usage would have cost on demand. AWS and Azure collection now records it on each covered row: for AWS, a savings plan's on-demand charge plus reserved instance hours priced from AWS's own on-demand cost of those hours; for Azure, your subscription's on-demand rate for the same meter. No published "up to" discount is ever used in its place.

Covered usage without an on-demand figure counts as having saved nothing, and the report says how much of the covered spend its savings figure measured. Cost history collected before this feature shipped has no on-demand figure, so savings for older periods read as not measured until that history is collected again.

## Export, sharing and folders

- **Export CSV** downloads the open report with one row per period (or per group and period) and every metric as a column. Ratios are fractions (0.85, not 85%), and an empty cell means "not measurable".
- **Share** works exactly like [cost report sharing](../team-and-billing/cost-visibility.md): an org default plus people and roles, with the creator as owner, and folder sharing inherited.
- [Cost visibility scopes](../team-and-billing/cost-visibility.md) apply: a scoped member's report only reads the accounts they may see in full.
- **Edit** and **Delete** follow the same sharing rules.

## Everywhere else

- **Desktop** shows the same section in cloud mode.
- **Mobile** lists saved reports on the Commitments tab of the Costs screen and opens one's totals and groups, read-only.
- **CLI**: `infrawrench commitments reports` lists them; `infrawrench commitments reports "<name>"` runs one (`--metric utilization` picks the sparkline, `--format csv --out report.csv` writes the CSV, `--json` prints everything). `infrawrench commitments report --last 90d --bin month --group-by account --provider aws` runs an unsaved one. See [CLI](./cli.md).
- **Terraform**: [`infrawrench_commitment_report`](./terraform-provider.md), with `infrawrench_object_sharing` (`object_type = "commitment_report"`) for sharing.
- **API**: `GET|POST /api/org/{orgId}/commitments/reports`, `GET|PUT|DELETE …/reports/{id}`, `POST …/reports/{id}/run`, `POST …/commitments/report-query` for an unsaved config and `GET …/commitments/report-options` for the picker values. Reads need `costs:read`, writes `costs:write`.
