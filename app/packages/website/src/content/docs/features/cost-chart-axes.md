---
title: Chart axes, comparison & drill-down
description: Put services, accounts or a tag on a cost chart's X axis, compare this period with the last one bar by bar, and click into any value to see what it is made of.
sidebar_order: 3
---

Every cost chart starts as spend over time: dates along the bottom, one coloured series per group. Three options let you ask the same data different questions, on any [cost graph](./cloud-costs.md) card and any [cost report](./cost-reports.md):

- **X axis** puts a dimension's values along the bottom instead of dates. Use it for "which services cost the most this month?" instead of "how did spend move day by day?".
- **Show the previous period as paired bars** draws last period's figure beside each bar, so you compare each bar on its own, not against one dashed line across the top.
- **Drill-down** narrows the chart to whatever you click and breaks it down one level further, without changing the saved chart.

> **Cloud only**, like every cost chart. Available on web and desktop. The [mobile app](./mobile-app.md) shows both chart modes read-only.

## Put a dimension on the X axis

1. Open a cost graph's editor (the pencil on a dashboard card, or **Edit** on a report).
2. Set **X axis** to a dimension: provider, account, service, region, resource, tag, charge type, commitment or virtual tag. For a tag or virtual tag, pick the key under **X axis tag key**.
3. Optionally set **Segment by** to split each bar:
   - **None** draws one bar per value.
   - **Date bin** stacks each value's bar by bin, so "which services cost the most" also shows _when_.
   - A second dimension (region, account, a tag...) stacks each bar by that dimension's values.
4. **Save**.

Values are ranked by spend over the whole range. The top values (set with **Top groups**) get their own bar and everything else goes into **Other**, as series do on a date axis. Segments work the same way.

<insert [Cost graph editor with X axis set to Service, Segment by set to Region, and the hint under it explaining that values are ranked by spend and the rest fold into Other] here>

Some options only make sense over time, so they're switched off when a dimension is on the X axis (and the API rejects them): **Forecast** (and any scenario), **Cumulative**, the **Count** measure and unit costs. Pie and donut charts have no X axis, so they aren't offered either. The table view is, and lists one row per value.

Spend with no value for the dimension (spend with no region, untagged spend) shows as **(no value)**, not hidden.

## Compare with the previous period

Turn on **Compare previous period**. On a bar chart, a second choice appears, **Show the previous period as**:

- **A dashed totals line:** one line over the top of the chart.
- **Paired bars beside each bar:** the previous period's total as a muted bar to the left of each current bar (or stack), so every bar reads "then, now".

Hover a bar for the previous figure with the change beside it, in money and as a percentage. The **table** view always lists three extra columns while comparing: **Previous period**, **Change** and **Change %**.

On a date axis, the first day (or week) of the previous period is compared with the first of this one, and so on. On a dimension axis, each value is compared with **itself**, so a service that ranked lower last month is still compared with its own figure, not with whatever was in "Other" then.

<insert [A stacked-bar cost card with Service on the X axis and the previous period drawn as muted paired bars to the left of each bar, with the tooltip open showing the previous figure and its change] here>

## Drill down

On any grouped chart, click a bar segment, a pie slice, a legend entry (the way in on a line or area chart), or a value in the table. The chart then:

1. adds what you clicked as a filter, and
2. regroups by the next level down.

The levels go **provider, then service, then region, then resource**. An **account** or **charge type** drills to service, and a **commitment** to resource. A **tag** or **virtual tag** has no obvious next level, and a **resource** is the bottom level, so clicking one of those asks which dimension to break it down by.

A row of breadcrumbs appears under the title: **All › AWS › AmazonEC2**. Click any level to step back up to it, or **All** to return to the chart as saved.

Drilling never changes the chart. The saved report or dashboard card, and what everyone else sees, stay as they were, and reloading starts from the top again. To keep a drilled view, click **Save as new report** on the report's page. It's saved as a new report named after the path ("Monthly spend › AWS › AmazonEC2"), in the same folder as the original.

<insert [A cost report page after drilling from provider into AWS and then into a service, showing the All › AWS › AmazonEC2 breadcrumbs under the title, the chart now grouped by region, and the Save as new report button] here>

### Without a mouse

Everything you can drill into by clicking is also in the **Drill into…** list under the chart, in the same order as the chart. Pick one with the keyboard and the chart drills just as a click would. When you need to choose the next level, focus moves to the first choice, and **Escape** cancels. In the table view, the values (or series headings) are buttons.

## In PDFs, on the phone, and from the command line

- **PDF export** and scheduled report PDFs show the dimension axis and paired bars, and when comparing, every table gets the previous period, change and change % columns.
- The **mobile app** shows a dimension axis as numbered bars with a ranked list of the values underneath, each with its total and change, and shows paired bars when the card uses them. Drilling is on web and desktop only.
- The **CLI** takes the same options:

```
infrawrench costs --x-axis service --compare               # one bar per service, with the change since last period
infrawrench costs --x-axis service --group-by region       # each service split by region
infrawrench costs --x-axis tag:team --segment-by-date      # each team split by day
infrawrench reports "Monthly spend" --x-axis account       # a one-off view of a saved report
infrawrench reports "By service" --x-axis date             # the date bins back, for a report saved with a dimension axis
```

With `--json`, the output includes the axis and an `xAxis` block listing the values in chart order with their labels.

## API, MCP and Terraform

- `POST /costs/query` takes `xAxis`, `xAxisTagKey` and `segmentByDate`. With a dimension on X, every series point's `bucket` is a dimension value instead of a date, and the response includes `xAxis` with the values in order. `comparisonStyle` (`line` or `bars`) is saved on a report's or card's config. See [the OpenAPI spec](../team-and-billing/openapi.md).
- `POST /cost-reports/{id}/run` accepts `xAxis` (or `date`) as a one-off override, and so does the `run_cost_report` [MCP](./mcp.md) tool; `query_costs` takes the same fields as the query.
- The [Terraform provider](./terraform-provider.md)'s `infrawrench_cost_report` has `x_axis`, `x_axis_tag_key`, `segment_by_date` and `comparison_style`.
- A dashboard in [org config as code](./config-as-code.md) takes the same options in each cost graph card's config.
