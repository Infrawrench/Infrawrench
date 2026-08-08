---
title: Cost reports
description: Save a cost graph as a named, addressable report, run it by name, and show it on as many dashboards as you like.
sidebar_order: 3
---

A cost graph on a dashboard is a card and nothing more: it belongs to that dashboard, it has no name anyone can say out loud, and rebuilding it somewhere else means re-picking the chart type, the binning, the grouping and every filter.

A **cost report** is the same graph as an object. It has a name, its own page, and an id — so it can be run from the CLI or from chat, and dashboards can point at it instead of copying it. Edit the report once and every dashboard showing it updates.

> **Cloud only.** Reports are org rows over spend collected by Infrawrench Cloud's background pollers. On the desktop app the Reports tab appears when you are signed into a cloud org; local-only mode has no spend to report on.

## Open the Reports page

**Reports** in the sidebar, next to **Costs**. It lists every saved report in the org, what each one charts, and how many dashboards carry a card for it.

<insert [Reports page listing three saved cost reports with their shapes and dashboard counts, one showing "On no dashboard"] here>

## Create a report

1. Open **Reports** and click **New report**.
2. Give it a name and configure the graph — the same editor a dashboard [cost graph](./cloud-costs.md#add-a-cost-graph) uses, with the same chart types, binning, date ranges, group-by, filters, cost basis, comparison and forecast options.
3. **Save**. You land on the report's own page.

<insert [The cost graph editor opened from the Reports page, with a name field filled in as "Monthly spend by service"] here>

A report saved with a **relative** date range ("last 30 days") means a different window every day it runs, which is usually what you want. Pin it to fixed dates with an absolute range instead.

## The report page

The report's page draws the chart full width, with the report's name, its description, and the dashboards it appears on. From here you can:

- **Edit** — change the graph. Every dashboard showing this report changes with it.
- **Rename** — the name is how people ask for it, in chat and on the command line.
- **Duplicate** — copy the config under a new name, so a variant does not mean editing the shared original.
- **Dashboards** — add or remove its cards, one per dashboard.
- **Delete** — see below.

<insert [A cost report's detail page showing the full-width chart, the report name, and a "On Production" dashboard link underneath] here>

## Show a report on a dashboard

A dashboard's **+** tile offers both kinds of cost chart:

| Menu entry       | What you get                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Cost graph**   | A one-off card owned by this dashboard. No name, no report, nothing else sees it.              |
| **Saved report** | A card pointing at a report. Editing the report updates this card and every other one with it. |

Both exist on purpose: putting one chart on one dashboard should not require naming and filing a report first.

A report card has no **Edit** of its own — it opens the report's page instead, where the list of everywhere else it appears is visible. Changing a shared report from one of its cards, without seeing the other four, is exactly the mistake this avoids.

<insert [Dashboard "+" tile menu open showing Pin a resource, Cost graph, Saved report, New budget, Existing budget, and Custom graph entries] here>

## Cards vs the report itself

The two directions are deliberately not symmetrical, the same way they are for [budgets](./cloud-costs.md#cards-vs-the-budget-itself):

| You do this                             | What happens                                                                |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Remove a report card from a dashboard   | The card goes. The report stays, and every other dashboard keeps its card.  |
| Delete the report from the Reports page | The report goes, and every card pointing at it is removed at the same time. |

A card whose report no longer exists could only ever render as an unavailable tile that no amount of dashboard editing explains — so deleting a report takes its cards with it. The confirmation names the dashboards that will lose a card before anything happens.

## From the command line

```
infrawrench reports                     # every saved report, with its shape and dashboard count
infrawrench reports "Monthly spend"     # run it and chart it in the terminal
infrawrench reports "Monthly spend" --json
```

The name is matched exactly first, then as a substring; an ambiguous query lists the candidates rather than picking one, because running the wrong cost report produces a wrong answer that looks right. An id works anywhere a name does. See [the CLI](./cli.md).

## From chat and MCP

Reports are exposed to the [MCP server](./mcp.md) and the [AI chat](./ai-chat.md) as `list_cost_reports`, `get_cost_report`, `run_cost_report`, `create_cost_report`, `update_cost_report`, and `delete_cost_report` — so "run the monthly spend report" works without restating a filter set. `run_cost_report` takes only the report's id and returns the series along with the window a relative range resolved to.

Reads need `costs:read` and writes need `costs:write`; see [roles & permissions](../team-and-billing/roles-and-permissions.md). Every create, update and delete lands in the [audit log](../team-and-billing/audit-log.md).

## On your phone

The [mobile app](./mobile-app.md) lists your saved reports and opens any one of them read-only — the chart, the description, and the dashboards it feeds, with a tap through to each. Report cards on a dashboard render there too.

Creating and editing a report stays on web and desktop: choosing a chart type, a binning, a group-by and a filter set is a desktop job, and a half-editor on a phone is the fastest way to change a report that five dashboards depend on by accident.

## When a report is worth making

- More than one person asks for the same breakdown, so it needs a name.
- The same chart belongs on two dashboards and you do not want to maintain both.
- You want the numbers on the command line, or want to ask chat for them, without restating the filters.

A chart you will look at once is still just a **Cost graph** on a dashboard, and that is fine.
