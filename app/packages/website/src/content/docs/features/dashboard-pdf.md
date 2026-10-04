---
title: PDF export and scheduled dashboards
description: Download any dashboard or cost report as a PDF, and send a dashboard on a schedule to Slack, Microsoft Teams or email with the PDF attached.
sidebar_order: 4
---

Every dashboard and every [cost report](./cost-reports.md) can be downloaded as a PDF, and a dashboard can be sent on a schedule: daily, weekly or monthly, to Slack channels, Microsoft Teams webhooks and email addresses, with the PDF attached. The finance alias that never logs in gets the same picture you see.

The PDF is rendered on the server, so web, desktop, the [mobile app](./mobile-app.md), the [CLI](./cli.md) and a scheduled delivery all produce the same document.

## Download a PDF

- **A dashboard:** open it and choose **Download PDF** in the header. Desktop offers it in cloud mode, where dashboards hold cost and custom-graph cards.
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
| Custom graph                   | Whatever the script draws, including its **stat** (KPI tile) and **table** forms. The script runs on the server, as it does on screen.                                                                                                   |
| Pinned resources and workflows | One table each: name, provider, type and account; workflow name and last run.                                                                                                                                                            |

Amounts are converted to the org's [display currency](./cloud-costs.md) when one is configured, and the PDF says so. A card that fails (a deleted budget, a custom graph whose script throws) shows its error in place instead of breaking the whole document. Each page has a footer with the dashboard name and page number, and the header links back to the live dashboard.

Cost cards need `costs:read`. A dashboard viewer without it still gets the PDF, with a note where each cost card would be, which matches what they see on screen.

## Schedule a dashboard

Open the dashboard and choose **Schedule delivery**. Schedules work exactly like [report delivery schedules](./cost-reports.md#scheduled-delivery):

- **A cadence:** daily, weekly (pick the weekday) or monthly (pick the day; the 31st means month end).
- **A local hour and time zone**, kept through daylight-saving changes.
- **Destinations:** any mix of the org's connected Slack channels, its Teams webhooks, and up to 20 email addresses.
- **Attach PDF:** on by default.

<insert [The Schedule delivery modal on a dashboard, listing one weekly schedule with "PDF attached" and its last status, and the New delivery schedule form open with the Attach PDF checkbox] here>

What each destination receives:

| Destination     | Message                                                                                                                                                                      | PDF                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Email           | The dashboard name and date, one line per card with a figure worth quoting (a cost graph's total and change, a budget's spend against its amount, a KPI's value), and a link | Attached                                                                                               |
| Slack           | The same summary and link                                                                                                                                                    | Uploaded as a reply in the message's thread                                                            |
| Microsoft Teams | The same summary and link                                                                                                                                                    | Not attached: Teams incoming webhooks cannot carry files, so the link is the way to the full dashboard |

**Slack needs the `files:write` scope** to upload the PDF. Workspaces connected before this feature existed still receive the message, just without the file, and **Send now** tells you how many channels missed it. Disconnect and reconnect Slack under **Settings → Notifications** to grant the scope. See [Slack alerts](./slack-alerts.md).

Status, retries and **Send now** behave as they do for reports: each schedule shows its last attempt and error, a total failure retries up to three times with a short backoff, and a partial delivery is never retried automatically because a retry would post twice where it already landed. Deleting a dashboard removes its schedules.

Viewing a dashboard's schedules needs `dashboards:read`; creating, editing, deleting and **Send now** need `org:settings:write`, because a schedule is standing authorisation to send the org's spend to addresses its creator picked. Every change and manual send is in the [audit log](../team-and-billing/audit-log.md).

## From the command line

```
infrawrench dashboards                                  # every dashboard, with its delivery schedules
infrawrench dashboards "Platform" --format pdf          # write platform.pdf in the current directory
infrawrench dashboards "Platform" --format pdf --out weekly.pdf
infrawrench dashboards send "Platform"                  # deliver it to its schedules right now
infrawrench reports "Monthly spend" --format pdf        # a saved report as a PDF
```

`--json` prints the path and size of the file written, or the per-schedule outcome of `send`. See [the CLI](./cli.md).

## With Terraform

Dashboard schedules are the `infrawrench_dashboard_notification` resource in the [Terraform provider](./terraform-provider.md), importable as `<dashboard-id>/<notification-id>`.

## Over the API

`GET /api/org/{orgId}/dashboards/{id}/pdf` and `GET /api/org/{orgId}/cost-reports/{id}/pdf` return the PDF (add `?tz=Europe/Berlin` to write the generated-at line in your zone). Schedules live under `/api/org/{orgId}/dashboards/{id}/notifications`. See the [API reference](../team-and-billing/openapi.md).

## Limits worth knowing

- The PDF is set in Helvetica, which covers Latin scripts. Characters outside it (for example a resource name in Japanese) print as `?`.
- Tables in the PDF stop at 50 rows and say how many more there were.
- Custom graphs render with their default control values; the selections you made on screen are not saved with the dashboard.
