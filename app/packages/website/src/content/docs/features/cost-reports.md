---
title: Cost reports
description: Save a cost graph as a named report, run it by name from the CLI or chat, and show it on as many dashboards as you like.
sidebar_order: 3
---

A cost report is a cost graph you save with a name. It gets its own page, you can run it from the CLI or ask for it in chat, and any number of dashboards can show it. Edit the report once and every dashboard showing it updates.

A plain cost graph on a dashboard belongs to that dashboard only. To use it somewhere else you would have to rebuild the chart type, binning, grouping and filters by hand. A report saves you that.

For a table of the resources themselves, with each one's cost beside its tags and metadata, see [resource reports](./resource-reports.md).

> **Cloud only.** Reports use the spend Infrawrench Cloud collects for your org. In the desktop app, the Reports tab appears when you are signed into a cloud org. Local-only mode has no spend to report on.

## Open the Reports page

Click **Reports** in the sidebar, next to **Costs**. You'll see every saved report in the org, what each one charts, and how many dashboards show it.

![Reports page listing three saved cost reports with their shapes and dashboard counts, one showing "On no dashboard"](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/reports-list.png)

## Create a report

1. Open **Reports** and click **New report**.
2. Give it a name and set up the graph. This is the same editor a dashboard [cost graph](./cloud-costs.md#add-a-cost-graph) uses, with the same chart types (including donut and table), measures (cost, usage quantity, count), binning (daily to quarterly), cumulative toggle, date ranges, group-by, filters, cost basis, comparison and forecast options. See [display options](./cloud-costs.md#display-options).
3. Click **Save**. You land on the report's own page.

![The cost graph editor opened from the Reports page, with a name field filled in as "Monthly spend by service"](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/report-editor-name.png)

A report with a **relative** date range ("last 30 days") covers a different window each day you run it, which is usually what you want. To pin it to fixed dates, use an absolute range.

## Use the report page

The report page shows the chart full width, with the report's name, description and the dashboards it appears on. From here you can:

- **Edit**: change the graph. Every dashboard showing this report changes with it.
- **Rename**: the name is how people ask for it in chat and on the command line.
- **Duplicate**: copy it under a new name, so you can try a variant without changing the shared original.
- **Dashboards**: add or remove its card on each dashboard.
- **Download FOCUS CSV**: the rows behind the chart as a [FOCUS 1.4](./cost-exports.md#focus) file, for a FinOps tool or a spreadsheet. See below.
- **Export…**: a larger file built in the background, as CSV, NDJSON or FOCUS. See [Large exports in the background](#large-exports-in-the-background).
- **Delete**: see [Cards vs the report itself](#cards-vs-the-report-itself).

Below the chart, **Forecasts** compares the automatic forecast with the report's named forecasts (your plans: scenario models stacked in order, optionally driven by a business metric's planned values), each with a low, expected and high range. See [Cost forecasts](./cost-forecasts.md).

### Download as FOCUS

**Download FOCUS CSV** gives you the rows the report selects (its date range as of today, its filters and its saved filter) in the FinOps Open Cost and Usage Specification 1.4 layout. You get one row per account, service, region, resource, tag set, charge type and commitment per day, with billed and effective cost side by side.

Grouping, binning and cost basis don't apply here. The file carries both cost bases and labels each row's charge type. It matches what a [FOCUS scheduled export](./cost-exports.md#focus) writes, so a one-off download and a nightly feed agree.

One download covers at most 366 days. For anything longer, or for a recurring feed, set up a scheduled export.

<insert [A cost report's detail page with the "Download FOCUS CSV" link highlighted in the header row, beside Dashboards and Rename] here>

### Large exports in the background

**Download FOCUS CSV** has to finish in a single download. For a long range, or a full year of per-resource FOCUS rows, use **Export…** instead. Infrawrench builds the file in the background and you collect it when it's ready.

Pick a format and a range (it starts at the report's own range), then click **Start export**:

- **CSV** or **NDJSON, report columns**: one row per day, per value of the report's group-by (service, account, a tag…) and per currency, with `amount`, `usage_amount` and `usage_unit`, plus `exported_at` and `collection_watermark` (the newest day every account has reported; rows after it may still change). The report's filters and cost basis apply.
- **FOCUS 1.4** or **1.3 CSV**: the same layout as the download above, every resource every day.

**If the report shows a unit cost**, the CSV and NDJSON files get six more columns: `unit_cost_metric`, `unit_cost_mode`, `unit_cost_scope_cost`, `unit_cost_metric_value`, `unit_cost_value` and `unit_cost_gap`. They hold each **day's** unit cost across the whole report, so the same values repeat on every row for that day. A day with no metric value has an empty `unit_cost_value` and the reason in `unit_cost_gap`, never a zero. See [Unit costs](./unit-costs.md#export-the-numbers).

You can close the dialog while the export runs. The report header keeps a short status ("Export 45%") and shows **Export ready** with a **Download** link when the file is done. **Your recent exports** in the dialog lists your last few exports with their status, so a file that finished while you were elsewhere is still one click away. You can cancel a running export from the same list. Files are kept for 24 hours, then deleted.

Good to know:

- The file's contents are fixed when you start it. Editing the report afterwards doesn't change an export that's already running.
- Rows follow your own [cost visibility](../team-and-billing/cost-visibility.md), the same as your charts.
- Each export covers at most 731 days and 256 MB, and you can run three at once.

<insert [The Export dialog on a cost report: the format picker set to CSV, report columns, the date range, and Your recent exports listing one export at 45% with a progress bar and one Ready with a Download link] here>

![A cost report's detail page showing the full-width chart, the report name, and a "On Production" dashboard link underneath](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/report-detail.png)

## Organize reports in folders

Once your list grows past a screenful, group it. Click **New folder** on the Reports page to make one. Every report and folder has a **Move** action, and each folder offers **New subfolder**, **Rename**, **Move** and **Delete**. Folders nest up to **three levels** deep, enough for "team / area / month".

![Reports page with reports grouped under a "Finance" folder and its "Monthly" subfolder, with the Move menu open on one report showing the folder targets](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/reports-folders-move.png)

Folders only organize the list. A report keeps its URL, its dashboard cards and its name in the [CLI](#from-the-command-line) and chat wherever you file it. So:

- **Deleting a folder never deletes a report.** Its reports move to the top of the list and its subfolders become top-level folders. The confirmation tells you this before anything happens.
- **Some moves aren't allowed.** You can't put a folder inside itself or one of its own subfolders, or nest anything past three levels. The move menu greys those options out.
- **You need edit access to the destination folder** to file a report or folder into it, whether you move it there or create it there. A folder's sharing extends to whatever is in it.

### Moving and deleting many at once

Every report and folder in the list has a checkbox. Tick several, **shift-click** to select everything between two rows, or use **Select contents** on a folder to pick every report in it. The bar above the list then offers **Move to folder…** and **Delete…**.

Keyboard shortcuts work while focus is in the list:

- **Ctrl+A** (⌘A on a Mac) selects everything.
- **M** opens the folder picker.
- **Delete** asks to delete the selection.
- **Esc** clears it.

You can also drag a selected row (or a folder heading) onto any folder heading in the list, or onto a folder in the **Folders** sidebar beside it, which also has **Top level**. Dragging a row that isn't selected moves just that row. A folder that can't take what you're dragging shows a red outline and says why.

A bulk move or delete is **all or nothing**. Before anything changes, Infrawrench checks that every item still exists, that your [sharing](./cost-reports.md) lets you edit it (or, to delete, that you own it), that you can edit the destination folder, and that nothing ends up nested past three levels. If any check fails, nothing changes, and the error names each item that blocked it.

Moved folders keep their contents. Deleting works the same as deleting one at a time: reports take their dashboard cards with them and their delivery schedules stop, and anything left in a deleted folder moves to the top level. The confirmation lists what goes and what moves, and each item gets its own [audit log](../team-and-billing/audit-log.md) entry.

<insert [Reports page with three reports ticked, the selection bar showing "3 selected · Move to folder… · Delete…", and the Folders sidebar with one folder highlighted as a drop target during a drag] here>

On the command line, `infrawrench reports` shows each report's folder path (`Finance / Monthly`) in its own column, and `--json` includes the folder list. The [mobile app](#on-your-phone) groups its read-only list the same way. In chat and MCP, `list_cost_reports` returns each item's `folderPath` and `move_cost_report` files a report by folder path, name or id.

## Show a report on a dashboard

A dashboard's **+** tile offers two kinds of cost chart:

| Menu entry       | What you get                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Cost graph**   | A one-off card owned by this dashboard. No name, no report, nothing else sees it.              |
| **Saved report** | A card pointing at a report. Editing the report updates this card and every other one with it. |

Use a cost graph when you just want one chart on one dashboard.

A report card has no **Edit** button of its own. It opens the report's page instead, where you can see every other dashboard that uses it before you change anything.

![Dashboard "+" tile menu open showing Pin a resource, Cost graph, Saved report, New budget, Existing budget, and Custom graph entries](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/dash-add-menu.png)

## Cards vs the report itself

Removing a card and deleting a report do different things, the same as for [budgets](./cloud-costs.md#cards-vs-the-budget-itself):

| You do this                             | What happens                                                                |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Remove a report card from a dashboard   | The card goes. The report stays, and every other dashboard keeps its card.  |
| Delete the report from the Reports page | The report goes, and every card pointing at it is removed at the same time. |

Before you delete a report, the confirmation names the dashboards that will lose a card. Deleting a report also removes its [delivery schedules](#scheduled-delivery).

## Scheduled delivery

The **Delivery** section on a report's page sends the report on a schedule to **Slack channels**, **Microsoft Teams webhooks** and **email addresses**. Each schedule has its own destinations, chosen when you create it.

![A report's detail page with the Delivery section showing two schedules, one "Weekly · Monday 08:00 Europe/Berlin" delivering to a Slack channel with status "Delivered", one monthly schedule to two email addresses with a red "Failed" status and its error text underneath](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/report-delivery.png)

Each schedule has:

- **A cadence**: daily, weekly (pick the weekday) or monthly (pick the day of the month). If a month doesn't have that day, it sends on the last day, so "the 31st" means month end in April too.
- **A local hour and time zone**: 08:00 in `Europe/Berlin` stays 08:00 through daylight-saving changes.
- **Destinations**: any mix of the org's connected Slack channels, its Teams webhooks and a list of email addresses (which can include, say, a finance alias with no Infrawrench login). You can only pick Slack and Teams destinations the org has already connected.

What arrives is a text summary: the report's total for its window (converted to your [display currency](./cloud-costs.md) if you've set one, with a note about the conversion), the change from the previous period, the top groups, and a link to the live report. The message has no chart, just the numbers and the link.

Want the chart on paper? **Download PDF** on the report page gives you the chart and its totals table as a PDF. To send charts on a schedule, put the report on a dashboard and [schedule the dashboard](./dashboard-pdf.md#schedule-a-dashboard), which attaches the whole dashboard as a PDF.

Two things to know:

- **An empty result still sends**, and says so, so you can tell a quiet period from a broken schedule.
- **Failures show on the report page.** Each schedule shows its last attempt's status and any error. A delivery that fails everywhere retries up to three times. A _partial_ delivery (Slack got it, Teams didn't) is not retried automatically, so the report isn't posted twice where it already landed. Fix the failing destination, then click **Send now**.

![The "New delivery schedule" modal with a weekly cadence, hour and timezone fields, Slack channel checkboxes, a Teams webhook checkbox, and an email recipients box filled in](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/report-delivery-modal.png)

Viewing a report's schedules needs `costs:read`. Creating, editing, deleting and **Send now** need `org:settings:write`, the same as [cost exports](./cost-exports.md), because a schedule sends org spend outside Infrawrench. Every change and manual send is recorded in the [audit log](../team-and-billing/audit-log.md).

## Drill into a report

Click a bar, a slice, a legend entry or a value in the table to narrow the report to it and break it down one level further (provider, then service, then region, then resource). Use the breadcrumbs under the title to step back up. The saved report doesn't change. To keep a drilled view, click **Save as new report**, which saves it in the same folder. See [Chart axes, comparison & drill-down](./cost-chart-axes.md#drill-down).

## Anomaly alerts for a report

[Anomaly detection](./cost-anomaly-alerts.md) watches the whole organization, one provider and one service at a time, and sends what it finds through the org's alert rules. If your team owns a report scoped to its own accounts, tags or cost centre, you probably want something narrower: an alert when **your** slice spikes, in **your** channel, at a threshold you choose. The **Anomaly alert** section on a report's page does that.

Click **Set up**, then choose:

- **Sensitivity**: how many standard deviations above the report's own trailing 28-day average a day has to be. Lower is more sensitive. The organization-wide default is 3.
- **Minimum rise per day**: how far above the average a day must be, in the spend's own currency, before you're alerted. This stops a small report from paging you over a few dollars.
- **Send to**: the same destination picker as [alert routing](./alert-routing.md): Slack channels, Teams webhooks, mobile push, whoever is on call on a rotation, members by email or an extra address, GitHub issues, or a paging provider.

<insert [A report's page with the Anomaly alert section in edit mode: sensitivity 2.5, minimum rise 50, and the destination picker with a Slack channel and an email address selected] here>

The alert watches the report's **total**: its filters and saved filter, per currency, ignoring grouping and display options. If you edit the report's filters, the alert follows. It checks after each cost collection and rechecks the last three days as late data arrives. Once it sends about a day, it stays quiet about that report and currency for seven days, the same as organization-wide detection.

It runs **alongside** the organization's anomaly alerts, not instead of them. Alert routing rules don't redirect, block or hold these messages for quiet hours: they go where the person who set them up chose. A push opens the report on your phone. The section also lists the latest findings: the day, the spend against its baseline, and whether it was sent.

Viewing a report's alert needs `costs:read` and access to the report. Setting it up, changing it or deleting it needs `org:settings:write`, like delivery schedules. If a member limited by [cost visibility](../team-and-billing/cost-visibility.md) sets one up, it only sees what they can see. Changes are recorded in the audit log. `infrawrench reports anomalies [<report>]` lists alerts and their findings from a terminal, and the Terraform resource is `infrawrench_cost_report_anomaly_alert`.

## Annotations

A jump in a spend chart is easy to explain for a couple of weeks. After that, nobody remembers whether it was a migration, a launch or a price change.

An **annotation** is a dated note drawn on the chart, so the explanation sits next to the number.

![A cost report chart with two numbered annotation markers on it, one a dashed vertical line labelled 1, one a shaded band labelled 2, and the annotation chips reading "Jul 4 · Migrated the API fleet to Graviton" and "Jul 18 to Jul 22 · Datacentre migration" underneath the chart](https://agent-assets.infrawrench.com/docs-screenshots/features/cost-reports/report-annotations.png)

### Write an annotation

Click any bar on the chart and write what happened, or click **Add annotation** in the **Annotations** list below it. You set:

- **A date**: the day it happened.
- **Spans several days** (optional): a deploy is a moment, a migration is a week. A span shades every bar it covers.
- **The note**: up to 500 characters.
- **Where it shows**: **every cost chart** (the default) or **only this report**.

Notes show on every cost chart by default, because something like "we changed instance types" affects more than one report. Limit a note to one report when it's really only about that report's spend.

### Where markers appear

A note is dated to a day, but a chart may group by day, week, month or quarter. The marker lands on **whichever bar contains that day**. Switch a chart from daily to monthly and a note dated the 14th moves onto that month's bar.

- **Several notes on one bar become one marker.** Three things that happened in July are one numbered flag on a monthly chart. The list underneath shows all three.
- **A note outside the chart's date range isn't drawn**, and doesn't stretch the axis.
- **A span that starts before the chart's range** still shows, starting at the first bar.

Annotations never change the numbers. Series, totals, forecast and axis are the same whether a chart has ten notes or none.

### Read annotations without a mouse

Every marker is also a button in the strip under the chart, showing its number, date and text. Tab to one and press Enter to expand every note on that bar, each with **Edit**. Nothing about annotations needs hover, so they work on a phone too.

### Notes created from an anomaly

When you explain a detected [cost anomaly](./cost-anomaly-alerts.md#explaining-an-anomaly), Infrawrench adds an annotation for you: dated to the anomalous day, shown on every chart, with the explanation you wrote. These markers say **Explains a detected anomaly** next to their date, so you can check the note against the finding it closed.

After that it's an ordinary annotation. You can reword it, limit it to one report, change its date or delete it. Deleting it removes only the marker: the anomaly stays explained. If you explain the anomaly again, the same note is updated rather than a second one added.

### Manage annotations

The **Annotations** list on a report's page shows every note the chart draws, both the report's own and the org-wide ones, each labelled. Go there to fix a date you can't see on the chart, reword a note, switch it between org-wide and this report, or delete it.

Reading annotations needs `costs:read`. Writing them needs `costs:write`. Every create, update and delete is recorded in the [audit log](../team-and-billing/audit-log.md).

## From the command line

```
infrawrench reports                     # every saved report, with its folder, shape, dashboards and delivery schedules
infrawrench reports "Monthly spend"     # run it and chart it in the terminal
infrawrench reports "Monthly spend" --json
infrawrench reports send "Monthly spend"  # deliver it to its schedules right now
infrawrench reports "Monthly spend" --format pdf  # write monthly-spend.pdf (or --out <path>)
infrawrench reports "Monthly spend" --bin quarter --cumulative   # a one-off view, nothing saved
infrawrench reports "Monthly spend" --measure count --json       # how many services were billed per bin
infrawrench reports "Monthly spend" --x-axis service             # one bar per service instead of dates
infrawrench reports move "Monthly spend" "Weekly spend" folder:"Finance / Old" --folder Archive
infrawrench reports move "Monthly spend" --folder top    # back to the top level
infrawrench reports delete "Old draft" folder:Scratch -y  # asks first without -y
infrawrench export --async --format csv "Monthly spend" --wait --out monthly.csv   # a background export of the report
infrawrench export jobs                 # your recent background exports and their status
infrawrench reports anomalies "Platform"  # a report's anomaly alert and its latest findings
```

`--measure cost|usage|count`, `--unit <usage unit>`, `--bin day|week|month|quarter|hour`, `--cumulative` and `--x-axis <dimension>|date` change how one run is measured, binned and laid out, without editing the saved report. Switching a run to usage or count drops the report's forecast, scenario and billing rules for that run, since they only apply to money. `--measure usage` without `--unit` lists the units in your cost data.

`move` and `delete` take one item per argument (quote names with spaces). Put `folder:` in front of a folder name. Like the Reports page, they're all or nothing, and `--json` prints what was moved or deleted.

The `delivery` column shows each report's schedules and flags failing ones. Sending needs the explicit `reports send` command, since it posts into channels and inboxes.

Names are matched exactly first, then as a substring. If your query matches more than one report, the CLI lists the matches instead of guessing. You can use an id anywhere a name works. See [the CLI](./cli.md).

## From chat and MCP

The [MCP server](./mcp.md) and the [AI chat](./ai-chat.md) can use your reports through `list_cost_reports`, `get_cost_report`, `run_cost_report`, `create_cost_report`, `update_cost_report`, `move_cost_report`, `delete_cost_report`, `bulk_move_cost_reports` and `bulk_delete_cost_reports`. So "run the monthly spend report" works without restating any filters.

- `run_cost_report` takes the report's id and returns the series, along with the dates a relative range resolved to. Optional `measure`, `usageUnit`, `binning`, `cumulative` and `xAxis` parameters change the view for that one call without saving anything.
- `move_cost_report` files a report in a [folder](#organize-reports-in-folders) by path, name or id, or back at the top level with `null`.

Reads need `costs:read` and writes need `costs:write`. See [roles & permissions](../team-and-billing/roles-and-permissions.md). Every create, update and delete is recorded in the [audit log](../team-and-billing/audit-log.md).

## On your phone

The [mobile app](./mobile-app.md) lists your saved reports, grouped under the same [folders](#organize-reports-in-folders) you use on web and desktop, with each section titled by the folder's full path. Open any report to see it read-only: the chart, the description, the dashboards that show it (tap through to each), and its [delivery schedules](#scheduled-delivery) with each one's last-send status and error.

Report cards on a dashboard show there too, using their saved display options: a table report shows as rows, a donut as a ring with its total, a report with a dimension on its X axis as numbered bars with the values listed underneath, and a usage or count report shows quantities and counts instead of money.

A report's [anomaly alert](#anomaly-alerts-for-a-report) shows there too, read-only, with its latest findings. A push about one opens the report. Annotation markers appear on the phone's charts, with the note a tap away.

These stay on web and desktop:

- Creating and editing reports.
- Managing folders, including moving or deleting several at once.
- Creating or editing delivery schedules and anomaly alerts.
- Writing annotations.

## When to make a report

- More than one person asks for the same breakdown.
- The same chart belongs on two dashboards and you don't want to maintain both.
- You want the numbers on the command line, or want to ask chat for them, without restating the filters.

For a chart you'll only look at once, a **Cost graph** on a dashboard is fine.
