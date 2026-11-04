---
title: PDF export and scheduled dashboards
description: Download any dashboard or cost report as a PDF, and send a dashboard on a schedule to Slack, Microsoft Teams or email with the PDF attached.
sidebar_order: 4
---

You can download any dashboard or [cost report](./cost-reports.md) as a PDF. You can also send a dashboard on a schedule (daily, weekly or monthly) to Slack channels, Microsoft Teams webhooks and email addresses, with the PDF attached. That way the finance team that never logs in sees the same picture you do.

Web, desktop, the [mobile app](./mobile-app.md), the [CLI](./cli.md) and scheduled deliveries all produce the same document.

## Download a PDF

- **A dashboard:** open it and choose **Download PDF** in the header. On desktop, this is available in cloud mode.
- **A cost report:** open the report from **Reports** and choose **Download PDF** beside its name.
- **On your phone:** **Share PDF** on a dashboard or a report opens the share sheet with the file.

<insert [A dashboard header with the Download PDF and Schedule delivery buttons, and the downloaded PDF open beside it showing a stacked bar chart, a totals table and a budget bar] here>

## What the PDF contains

The cards appear in the order they sit on the dashboard, one after another on A4 pages:

| Card                           | In the PDF                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost graph, saved report       | The chart (stacked bar, bars, line, area or pie), with the forecast and any scenario drawn dashed, and a totals table per group. When the card compares against the previous period, the table gains the previous figure and the change. |
| Unit cost                      | The ratio over time and the whole-period figure.                                                                                                                                                                                         |
| Budget                         | Spend against the amount as a bar, the month's forecast as a lighter extension, a tick per threshold, and the thresholds already crossed this month.                                                                                     |
| Custom graph                   | Whatever the script draws, including its **stat** (KPI tile) and **table** forms. The script runs just as it does on screen.                                                                                                             |
| KPI                            | The figure as a tile, with the change against the previous period (good news and bad news coloured as on screen) and the window it covers.                                                                                               |
| Text                           | The card's notes as plain paragraphs: headings and lists keep their words, and links print with their address.                                                                                                                           |
| Pinned resources and workflows | One table each: name, provider, type and account; workflow name and last run.                                                                                                                                                            |

If your org has a [display currency](./cloud-costs.md) set, amounts are converted to it and the PDF says so. If a card fails (a deleted budget, or a custom graph whose script throws an error), its error shows in its place and the rest of the document still renders. Each page has a footer with the dashboard name and page number, and the header links back to the live dashboard.

Cost cards need `costs:read`. A viewer without it still gets the PDF, with a note where each cost card would be, just like on screen.

## Schedule a dashboard

Open the dashboard and choose **Schedule delivery**. Schedules work just like [report delivery schedules](./cost-reports.md#scheduled-delivery):

- **A cadence:** daily, weekly (pick the weekday) or monthly (pick the day; the 31st means month end).
- **A local hour and time zone**, kept through daylight-saving changes.
- **Destinations:** any mix of your org's connected Slack channels, Teams webhooks and up to 20 email addresses.
- **Attach PDF:** on by default.

<insert [The Schedule delivery modal on a dashboard, listing one weekly schedule with "PDF attached" and its last status, and the New delivery schedule form open with the Attach PDF checkbox] here>

What each destination receives:

| Destination     | Message                                                                                                                                                                      | PDF                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Email           | The dashboard name and date, one line per card with a figure worth quoting (a cost graph's total and change, a budget's spend against its amount, a KPI's value), and a link | Attached                                                                                    |
| Slack           | The same summary and link                                                                                                                                                    | Uploaded as a reply in the message's thread                                                 |
| Microsoft Teams | The same summary and link                                                                                                                                                    | Not attached (Teams webhooks can't carry files), so use the link to open the full dashboard |

**Slack needs the `files:write` scope** to upload the PDF. If your workspace was connected before this feature existed, it still gets the message without the file, and **Send now** tells you how many channels missed it. To grant the scope, disconnect and reconnect Slack under **Settings > Notifications**. See [Slack alerts](./slack-alerts.md).

Status, retries and **Send now** work as they do for reports:

- Each schedule shows its last attempt and any error.
- If a delivery fails completely, it's retried up to three times.
- A partial delivery is never retried automatically, so nobody gets the message twice.
- Deleting a dashboard removes its schedules.

Viewing a dashboard's schedules needs `dashboards:read`. Creating, editing, deleting and **Send now** need `org:settings:write`, since a schedule keeps sending your org's spend to the addresses its creator chose. Every change and manual send is recorded in the [audit log](../team-and-billing/audit-log.md).

## From the command line

```
infrawrench dashboards                                  # every dashboard, with its delivery schedules
infrawrench dashboards "Platform" --format pdf          # write platform.pdf in the current directory
infrawrench dashboards "Platform" --format pdf --out weekly.pdf
infrawrench dashboards send "Platform"                  # deliver it to its schedules right now
infrawrench reports "Monthly spend" --format pdf        # a saved report as a PDF
```

With `--json`, you get the path and size of the file written, or the result per schedule for `send`. See [the CLI](./cli.md).

## With Terraform

Dashboard schedules are the `infrawrench_dashboard_notification` resource in the [Terraform provider](./terraform-provider.md), importable as `<dashboard-id>/<notification-id>`.

## Over the API

`GET /api/org/{orgId}/dashboards/{id}/pdf` and `GET /api/org/{orgId}/cost-reports/{id}/pdf` return the PDF (add `?tz=Europe/Berlin` to write the generated-at line in your zone). Schedules live under `/api/org/{orgId}/dashboards/{id}/notifications`. See the [API reference](../team-and-billing/openapi.md).

## Limits

- The PDF is set in Helvetica, which covers Latin scripts. Characters outside it (for example a resource name in Japanese) print as `?`.
- Tables in the PDF stop at 50 rows and say how many more there are.
- Custom graphs use their default control values. Selections you made on screen aren't saved with the dashboard.
