---
title: Chart axes, comparison & drill-down
description: Put services, accounts or a tag on a cost chart's X axis, compare this period with the last one bar by bar, and click into any value to see what it is made of.
sidebar_order: 3
---

Every cost chart starts out as spend over time: dates along the bottom, one coloured series per group. Three options turn the same data into other answers, on any [cost graph](./cloud-costs.md) card and any [cost report](./cost-reports.md):

- **X axis** puts a dimension's values along the bottom instead of dates, for "which services cost the most this month?" rather than "how did spend move day by day?".
- **Show the previous period as paired bars** draws last period's figure beside each bar, so the comparison is per bucket or per value, not one dashed line across the top.
- **Drill-down** narrows the chart to whatever you click and breaks it down one level further, without changing the saved chart.

> **Cloud only**, like every cost chart. Available on web and desktop; the [mobile app](./mobile-app.md) draws both chart modes read-only.

## Put a dimension on the X axis

1. Open a cost graph's editor (the pencil on a dashboard card, or **Edit** on a report).
2. Set **X axis** to a dimension: provider, account, service, region, resource, tag, charge type, commitment or virtual tag. For a tag or virtual tag, pick the key under **X axis tag key**.
3. Optionally set **Segment by** to split each bar:
   - **None** draws one bar per value.
   - **Date bin** stacks each value's bar by bin, so "which services cost the most" also shows _when_.
   - A second dimension (region, account, a tag...) stacks each bar by that dimension's values.
4. **Save**.

Values are ranked by spend over the whole range. The top values (set with **Top groups**) get their own bar and everything else folds into **Other**, as series do on a date axis. Segments are folded the same way.

<insert [Cost graph editor with X axis set to Service, Segment by set to Region, and the hint under it explaining that values are ranked by spend and the rest fold into Other] here>

Some options only mean something over time, so the editor switches them off when a dimension goes on the X axis, and the server refuses them if they are sent anyway: **Forecast** (and any scenario), **Cumulative**, the **Count** measure and unit costs. Pie and donut charts have no X axis, so they are not offered either; the table view is, and lists one row per value.

Values with no dimension value at all (spend with no region, untagged spend) appear as **(no value)** rather than being dropped.

## Compare with the previous period

Turn on **Compare previous period** as before. On a bar chart a second choice appears, **Show the previous period as**:

- **A dashed totals line** is the long-standing overlay: one line over the top of the chart.
- **Paired bars beside each bar** draws the previous period's total as a muted bar to the left of each current bar (or stack), so every bucket or value reads "then, now".

Hover a bar for the previous figure with the change beside it, in money and as a percentage. The **table** view always lists three extra columns while comparing: **Previous period**, **Change** and **Change %**.

On a date axis, bin number _n_ of the previous period is compared with bin number _n_ of this one. On a dimension axis each value is compared with **itself**: the previous period is folded onto this period's top values, so a service that ranked lower last month is still compared with its own figure, not with whatever "Other" held then.

<insert [A stacked-bar cost card with Service on the X axis and the previous period drawn as muted paired bars to the left of each bar, with the tooltip open showing the previous figure and its change] here>

## Drill down

On any grouped chart, click a bar segment, a pie slice, a legend entry (the way in on a line or area chart), or a value in the table. The chart then:

1. adds what you clicked as a filter, and
2. regroups by the next level down.

The levels follow how spend narrows: **provider → service → region → resource**; an **account** or a **charge type** drills to service, a **commitment** to resource. A **tag** or **virtual tag** has no natural next level, and a **resource** is the bottom of the hierarchy, so clicking one of those asks which dimension to break it down by instead.

A row of breadcrumbs appears under the title: **All › AWS › AmazonEC2**. Click any level to step back up to it, or **All** to return to the chart as saved.

Drilling never edits the chart. The saved report or dashboard card, and what everybody else sees, stay exactly as they were, and a reload starts from the top again. To keep a drilled view, click **Save as new report** on the report's page: it becomes a new report, named after the path ("Monthly spend › AWS › AmazonEC2") and filed in the same folder as the one it came from.

<insert [A cost report page after drilling from provider into AWS and then into a service, showing the All › AWS › AmazonEC2 breadcrumbs under the title, the chart now grouped by region, and the Save as new report button] here>

### Without a mouse

Every drill a click can do is also in the **Drill into…** list under the chart, which lists the values in the order the chart draws them. Pick one with the keyboard and the chart drills exactly as a click would. When the next level is your choice, focus moves to the first choice, and **Escape** cancels. In the table view, the values (or the series headings) are buttons.

## In PDFs, on the phone, and from the command line

- **PDF export** and scheduled report PDFs draw the dimension axis and the paired bars, and every table gains the previous period, change and change % columns when comparing.
- The **mobile app** draws a dimension axis as numbered bars with a ranked list of the values underneath, each with its total and change, and draws paired bars when the card asks for them. Drilling stays on web and desktop.
- The **CLI** takes the same options:

```
infrawrench costs --x-axis service --compare               # one bar per service, with the change since last period
infrawrench costs --x-axis service --group-by region       # each service split by region
infrawrench costs --x-axis tag:team --segment-by-date      # each team split by day
infrawrench reports "Monthly spend" --x-axis account       # a one-off view of a saved report
infrawrench reports "By service" --x-axis date             # the date bins back, for a report saved with a dimension axis
```

`--json` echoes the axis and returns the server's `xAxis` block, which lists the values in drawing order with their labels.

## API, MCP and Terraform

- `POST /costs/query` takes `xAxis`, `xAxisTagKey` and `segmentByDate`. With a dimension on X, every series point's `bucket` is a dimension value rather than a date, and the response carries `xAxis` with the values in order. `comparisonStyle` (`line` or `bars`) is saved on a report's or card's config. See [the OpenAPI spec](../team-and-billing/openapi.md).
- `POST /cost-reports/{id}/run` accepts `xAxis` (or `date`) as a one-off override, and so does the `run_cost_report` [MCP](./mcp.md) tool; `query_costs` takes the same fields as the query.
- The [Terraform provider](./terraform-provider.md)'s `infrawrench_cost_report` has `x_axis`, `x_axis_tag_key`, `segment_by_date` and `comparison_style`.
- A dashboard in [org config as code](./config-as-code.md) carries the same options inside each cost graph card's config.
