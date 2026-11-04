---
title: Canvases
description: Describe a cost report in plain words and the AI assistant builds it as a saved, refreshable canvas of KPI tiles, charts, tables, budgets, anomalies and short narrative.
sidebar_order: 4
---

A **canvas** is a cost report you describe instead of building by hand. Type "monthly AI spend by team for the last 6 months, with cost per active user" and the [AI assistant](./ai-chat.md) builds it from your cost data: KPI tiles, charts, tables, budgets, anomalies, unit costs, saved reports, data from your other connected tools, and a few lines of text that quote the figures.

A canvas saves the **queries**, not the numbers. Opening it, clicking **Refresh**, exporting a PDF or sending it on a schedule all rerun those queries against your current data, without calling the assistant. The assistant is only used when you create or change a canvas.

> **Cloud only.** Canvases work with spend collected by Infrawrench Cloud. On the desktop app, the **Canvases** tab appears when you're signed in to a cloud org. Building and editing a canvas uses AI chat, so it's billed like any other chat message (see [AI chat billing](./ai-chat.md#billing)). Refreshing one isn't.

## Build a canvas

1. Open **Canvases** in the sidebar, next to **Costs** and **Reports**.
2. Describe the report in the box at the top, or pick one of the examples.
3. Click **Build canvas**.

The canvas opens with the assistant's conversation beside it. The assistant looks up what it needs (provider and service names, tag values, your business metrics, budgets and saved reports), then writes the canvas. You can follow each step in the conversation, and the canvas fills in when it's done.

<insert [Canvases page: the prompt box with "Monthly AI spend by team for the last 6 months, with cost per active user" typed in, and two existing canvases listed below] here>

<insert [A freshly built canvas: KPI tiles for this month's AI spend and cost per active user, a monthly table of AI spend by team, a short narrative paragraph, and the assistant's conversation open on the right] here>

## What a canvas can show

| Block        | What it is                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI tile     | One figure: spend over a window, cost per unit of a [business metric](./unit-costs.md), the month-end forecast, a budget's percent used, or an anomaly count. Optional change against the previous period. |
| Chart        | The same cost graph a dashboard card draws, including unit-cost charts, forecasts, comparisons and scenarios.                                                                                              |
| Table        | Spend grouped by provider, account, service, region, resource, tag, charge type or commitment, one column per day, week or month.                                                                          |
| Budgets      | Some or all of your [budgets](./cloud-costs.md#budgets) with this month's progress.                                                                                                                        |
| Anomalies    | Recent [cost anomalies](./cost-anomaly-alerts.md).                                                                                                                                                         |
| Saved report | One of your [cost reports](./cost-reports.md).                                                                                                                                                             |
| Custom graph | A [custom graph](./custom-graphs.md), which is how a canvas brings in data from your other connected tools, such as resource metrics or a provider API.                                                    |
| Text         | A heading and a sentence or two. Figures in the text come from KPI tiles, so they refresh with everything else.                                                                                            |

Canvases respect [cost visibility scopes](../team-and-billing/cost-visibility.md). Every figure uses the viewer's own scope, so two people opening the same canvas can see different numbers. Anomalies are hidden from scoped viewers, just like everywhere else.

## Change a canvas

Click **Edit with AI** and ask for the change: "split the table by region", "add a tile for the forecast", "drop the anomalies". The assistant proposes an edit, and nothing changes until you approve it.

- The approval card in the conversation lists what the edit adds, removes, changes and moves.
- The canvas page shows a banner with the same list and a **Preview proposed** toggle. It shows the proposed canvas with changed blocks outlined, so you can check the result first.
- Click **Approve** in the conversation to apply the edit, or **Reject** to leave the canvas as it was.

<insert [A canvas with the "The assistant proposed changes to this canvas" banner showing "+ Add table "Spend by region"" and the approval card in the conversation alongside] here>

Some edits don't need the assistant. Hover over a block to move it up or down or remove it, and click **Edit** on a chart to open the regular cost graph editor. **Rename** and **Delete** are in the header.

If someone shared a canvas with you as an editor, **Edit with AI** starts your own conversation. Chat history is per person.

## Refresh, export and schedule

- **Refresh** reruns every query. The time it last ran is shown under the title.
- **Download PDF** gives you the same document a schedule attaches. See [Dashboard and report PDFs](./dashboard-pdf.md).
- **Delivery**, at the bottom of the page, sends the canvas to Slack, Microsoft Teams or email daily, weekly or monthly, with the PDF attached. These work like [report delivery](./cost-reports.md) schedules and need the same permission (`org:settings:write`). A schedule set up by someone with a cost visibility scope only delivers what they can see.

## Share and pin

- **Share** opens the same sharing dialog reports and dashboards use. Whoever created a canvas owns it.
- **Dashboards** pins the canvas to any dashboard as a card. Editing the canvas updates every card, removing a card keeps the canvas, and deleting the canvas removes its cards.

## Safety

The assistant can only write a canvas through one tool, `write_cost_canvas`, and every canvas is checked against a strict schema before it's saved. Filters are the same structured filters every cost chart uses. No field accepts a query string or SQL, and unknown fields are rejected. Blocks refer to things by id (a budget, a business metric, a saved report, a custom graph), and the assistant looks those ids up rather than making them up.

## On mobile

The [mobile app](./mobile-app.md) lists canvases under **Costs** and shows them read-only. Pull to refresh reruns the queries, and **Share PDF** exports one. Building and editing are on web and desktop only.

## From the CLI, MCP, API and Terraform

```sh
infrawrench canvas list
infrawrench canvas show "AI spend by team"
infrawrench canvas refresh "AI spend by team" --json
infrawrench canvas refresh "AI spend by team" --format pdf --out ai-spend.pdf
```

`refresh` prints each block's figures. `--json` gives the full result, chart series included. See [CLI](./cli.md).

MCP clients get `list_cost_canvases`, `get_cost_canvas`, `run_cost_canvas`, `write_cost_canvas` and `delete_cost_canvas`. See [MCP](./mcp.md).

The API is `/api/org/{orgId}/cost-canvases` (see [OpenAPI](../team-and-billing/openapi.md)). The Terraform provider manages canvases and their schedules as `infrawrench_cost_canvas` and `infrawrench_cost_canvas_notification` (see [Terraform provider](./terraform-provider.md)).
