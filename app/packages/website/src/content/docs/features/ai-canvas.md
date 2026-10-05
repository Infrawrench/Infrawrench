---
title: Canvases
description: Describe a cost report in plain words and the AI assistant builds it as a saved, refreshable canvas of KPI tiles, charts, tables, budgets, anomalies and short narrative.
sidebar_order: 4
---

A **canvas** is a report you describe rather than assemble. Type "monthly AI spend by team for the last 6 months, with cost per active user" and the [AI assistant](./ai-chat.md) builds it from your cost data: KPI tiles, charts, tables, budgets, anomalies, unit costs, saved reports, data from your other connected tools, and a few lines of narrative that quote the figures.

The important part is what gets saved. A canvas stores the **queries**, not the numbers. Opening it, pressing **Refresh**, exporting it as a PDF or sending it on a schedule all re-run those queries against your current data, deterministically and without calling the assistant. The assistant is only involved when a canvas is created or changed.

> **Cloud only.** Canvases are built by the cloud chat agent over spend collected by Infrawrench Cloud. On the desktop app the **Canvases** tab appears when you are signed into a cloud org. Building and editing a canvas uses the AI chat, so it is metered like any other chat turn (see [AI chat billing](./ai-chat.md#billing)); refreshing one is not.

## Build a canvas

1. Open **Canvases** in the sidebar, next to **Costs** and **Reports**.
2. Describe the report in the box at the top, or pick one of the examples.
3. Click **Build canvas**.

The canvas opens with the assistant's conversation beside it. The assistant looks up what it needs (provider and service names, tag values, your business metrics, budgets and saved reports) with the same tools the chat uses, then writes the canvas. You see each step in the conversation and the canvas fills in when it is done.

<insert [Canvases page: the prompt box with "Monthly AI spend by team for the last 6 months, with cost per active user" typed in, and two existing canvases listed below] here>

<insert [A freshly built canvas: KPI tiles for this month's AI spend and cost per active user, a monthly table of AI spend by team, a short narrative paragraph, and the assistant's conversation open on the right] here>

## What a canvas can show

| Block        | What it is                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI tile     | One figure: spend over a window, cost per unit of a [business metric](./unit-costs.md), the month-end forecast, a budget's percent used, or an anomaly count. Optional change against the previous period. |
| Chart        | A cost graph, exactly the one a dashboard card draws, including unit-cost charts, forecasts, comparisons and scenarios.                                                                                    |
| Table        | Spend grouped by provider, account, service, region, resource, tag, charge type or commitment, one column per day, week or month.                                                                          |
| Budgets      | Some or all of your [budgets](./cloud-costs.md#budgets) with this month's progress.                                                                                                                        |
| Anomalies    | Recent [cost anomalies](./cost-anomaly-alerts.md).                                                                                                                                                         |
| Saved report | One of your [cost reports](./cost-reports.md).                                                                                                                                                             |
| Custom graph | A [custom graph](./custom-graphs.md): how a canvas carries data from your other connected tools, such as resource metrics or a provider API.                                                               |
| Text         | A heading and a sentence or two. Figures in the text are references to KPI tiles, so they refresh with everything else.                                                                                    |

Canvases respect [cost visibility scopes](../team-and-billing/cost-visibility.md): every figure is computed with the viewer's own scope, so two people opening the same canvas can see different numbers, and anomalies are withheld from scoped viewers exactly as they are everywhere else.

## Change a canvas

Click **Edit with AI** and ask for the change in the conversation: "split the table by region", "add a tile for the forecast", "drop the anomalies". The assistant proposes an edit, and nothing changes until you approve it:

- The approval card in the conversation lists what the edit adds, removes, changes and moves.
- The canvas page shows a banner with the same list and a **Preview proposed** toggle, which renders the proposed canvas with the changed blocks outlined, so you can look at the result before accepting it.
- **Approve** in the conversation applies the edit; **Reject** leaves the canvas as it was.

<insert [A canvas with the "The assistant proposed changes to this canvas" banner showing "+ Add table "Spend by region"" and the approval card in the conversation alongside] here>

Some edits don't need the assistant. Hover a block to move it up or down or remove it, and click **Edit** on a chart to open the regular cost graph editor. **Rename** and **Delete** are in the header.

If a canvas was shared with you as an editor, **Edit with AI** starts a conversation of your own; chat history is per person.

## Refresh, export and schedule

- **Refresh** re-runs every query. The time it last ran is under the title.
- **Download PDF** renders the canvas server-side, the same document a schedule attaches. See [Dashboard and report PDFs](./dashboard-pdf.md).
- **Delivery** at the bottom of the page sends the canvas to Slack, Microsoft Teams or email on a daily, weekly or monthly schedule, with the PDF attached. Schedules are the same as [report delivery](./cost-reports.md) schedules and need the same permission (`org:settings:write`). A schedule created by someone with a cost visibility scope delivers only what they can see.

## Share and pin

- **Share** opens the same sharing dialog reports and dashboards use. The person who created a canvas owns it.
- **Dashboards** pins the canvas to any dashboard as a card. The card is a view onto the canvas: editing the canvas changes every card, removing a card leaves the canvas, and deleting the canvas removes its cards.

## Safety

The assistant writes a canvas through one tool, `write_cost_canvas`, and the canvas it writes is checked against a strict schema before it is saved. Filters are the same structured filters every cost chart uses; there is no field that accepts a query string or SQL, and an unknown field is rejected rather than ignored. Every block refers to things by id (a budget, a business metric, a saved report, a custom graph), and the assistant looks those ids up instead of inventing them.

## On mobile

The [mobile app](./mobile-app.md) lists canvases under **Costs** and renders them read-only. Pull to refresh re-runs the queries, and **Share PDF** exports one. Building and editing stay on web and desktop.

## From the CLI and MCP

```sh
infrawrench canvas list
infrawrench canvas show "AI spend by team"
infrawrench canvas refresh "AI spend by team" --json
infrawrench canvas refresh "AI spend by team" --format pdf --out ai-spend.pdf
```

`refresh` prints each block's figures; `--json` carries the full result, chart series included. See [CLI](./cli.md).

MCP clients get `list_cost_canvases`, `get_cost_canvas`, `run_cost_canvas`, `write_cost_canvas` and `delete_cost_canvas`. See [MCP](./mcp.md).

The API is `/api/org/{orgId}/cost-canvases` (see [OpenAPI](../team-and-billing/openapi.md)), and the Terraform provider manages vetted canvases and their schedules as `infrawrench_cost_canvas` and `infrawrench_cost_canvas_notification` (see [Terraform provider](./terraform-provider.md)).
