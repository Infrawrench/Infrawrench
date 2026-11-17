---
title: "Commitment reports: coverage, utilization and savings over time"
description: Saved reports on how your reserved instances, savings plans and committed-use discounts performed per day, week, month or quarter, measured from your own cost data.
date: 2026-11-17
author: The Infrawrench team
---

Buying a savings plan or a reservation is the easy part. Knowing whether it paid off is harder: how much of your usage it covered, how much of what you committed to went unused, and what you actually saved against on demand, week after week.

The Costs app's **Commitments & credits** tab already answered that for the last 30 days. **Commitment reports** answer it over time, and keep the answer under a name you can open again, share and export.

![An open commitment report: coverage, utilization, savings and commitment cost, a weekly coverage chart per provider and a table with every metric](/blog/commitment-reports/01-report.png)

## What a report shows

Pick a window, a granularity (daily, weekly, monthly or quarterly), a grouping and any filters. Every report carries the same metrics:

- **Coverage**, shown as a range: the share of all usage a commitment covered, up to the share of the usage a commitment could have covered.
- **Utilization**: the share of what you committed to that paid for usage.
- **Effective savings rate** and **net savings vs on-demand**, with unused commitment counted against you.
- **On-demand remainder**: what you still paid on demand.
- **Commitment cost**, split into used and unused.

The chart draws one metric over time, one line per group. The table under it always has all of them, and **Export CSV** downloads the lot.

In the report above, a savings plan bought in late September shows up as a step in AWS coverage, while Azure stays flat. That is the kind of question a report is for: did the thing we bought do what we expected, and is anything going to waste.

## Building one

The editor is short. The name is the title, settings sit under Period, Display and Filters, and filters start as pills you add only when you need them: providers, commitment types, accounts, services, regions or specific commitments, each picked from what your organization actually has.

![The New commitment report dialog: last 90 days, weekly, coverage grouped by provider, filtered to AWS and Azure](/blog/commitment-reports/02-editor.png)

Reports file into the same folders as cost reports and share the same way, so a FinOps folder can hold the quarterly review next to the rest of your cost reporting.

![The Commitment reports list: two reports at the top level and one in a FinOps folder](/blog/commitment-reports/03-list.png)

## Savings are measured, not estimated

A savings figure needs to know what your covered usage would have cost on demand. Infrawrench now records that on each covered cost row, from AWS's and Azure's own figures for your account, not from public list prices, which would overstate savings against the rates you actually negotiated.

Covered usage without an on-demand figure counts as saving nothing, and the report tells you how much of the covered spend it could measure. Cost history collected before this release has no on-demand figure, so savings for older periods read as not measured until that history is collected again.

## Honest about what it can't see

AWS and Azure are measured. Providers whose commitments are listed but whose cost data does not separate covered from uncovered usage, Google Cloud among them today, are named as **not measured** rather than shown as 0% covered. A dash in the table means there was nothing to measure, never zero.

Two provider quirks are called out where they matter. AWS cannot tie covered usage to a specific reservation or plan, so under a commitment grouping it appears as **Covered, commitment not reported**. And AWS books a month's unused commitment on a single day, so a daily or weekly report with AWS in it says so and points you at monthly granularity for utilization.

## Everywhere you work

The same numbers come out of every surface, because every surface uses one shared definition of each metric:

- **Web and desktop**: the Commitment reports section on the Costs page's Commitments & credits tab.
- **Mobile**: your saved reports, read-only, with their totals and groups.
- **CLI**: `infrawrench commitments reports` lists them, `infrawrench commitments reports "<name>"` runs one, and `infrawrench commitments report --last 90d --bin month --group-by account` runs one without saving it.
- **Chat and MCP**: `list_commitment_reports` and `run_commitment_report`, so you or your coding agent can ask how your commitments did last quarter.
- **Terraform**: the `infrawrench_commitment_report` resource.
- **API**: endpoints under `/commitments/reports`.

The holdings list on the same tab also got more detail: term, payment option, start date, upfront and recurring amounts, and a badge when a commitment expires within 60 days.

## Try it

Open **Costs**, then **Commitments & credits**, then **Commitment reports**, and click **New report**. The [commitment reports docs](/docs/features/commitment-reports) define every metric and what each provider supports.
