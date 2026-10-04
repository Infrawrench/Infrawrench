---
title: Sentry
description: Track estimated Sentry spend by data category and project, and manage projects, teams, releases, issues, client keys, alerts, monitors, cron monitors and uptime monitors.
sidebar_order: 51
---

## What you can manage

- **Organization**: this month's usage per data category (errors, spans, replays, attachments, logs, profiling, cron and uptime monitors) with what was accepted, filtered and rate limited, the billable volume beyond your plan's allowance and an estimated cost, plus accepted errors, spans and replays by project. The Metrics tab charts daily usage per category and outcome.
- **Projects**: platform, teams, events accepted and dropped in the last 24 hours, the number of unresolved issues and the ten busiest ones, each with **Resolve** and **Archive** buttons. **Create** a project for a team (picked from a list) with a platform, **Edit** its name and platform, or delete it. The Metrics tab charts accepted, filtered and rate-limited errors, spans, transactions and replays.
- **Teams**: members and projects. Create, rename or delete a team.
- **Releases**: the 100 most recent, with when they were created and released, their projects, the new issues they introduced, commits and the last deploy.
- **Issues**: the 100 unresolved issues with the most events in the last 14 days, shown under their project. **Resolve**, **Archive until escalating**, **Archive forever** or **Reopen**, and chart the issue's events.
- **Client keys (DSN)**: the DSN your SDKs send with, whether the key is enabled, and its rate limit. **Create** a key on a project, **Edit** its name and rate limit, **Enable** or **Disable** it, or delete it.
- **Alerts**: triggers, filters, actions, connected monitors and when the alert last fired. **Enable** or **Disable**, **Edit** the name and action interval, or delete.
- **Monitors** (Sentry's issue detectors: error, metric and issue stream monitors): type, aggregate, filter, thresholds, connected alerts and the latest issue. **Enable**, **Disable** or delete.
- **Cron monitors**: schedule, margins and the status of each environment. **Pause** or **Resume**, **Mute** or **Unmute**, **Edit** the name, schedule (a crontab such as `0 * * * *`, or an interval such as `10 minute`), timezone, check-in margin and maximum runtime, or delete. The Metrics tab charts run durations and failed check-ins.
- **Uptime monitors**: URL, method, interval, timeout and whether the URL is up. **Pause** or **Resume**, **Edit** the name, URL, interval and timeout, or delete. The Metrics tab charts successful and failed checks.

## Credentials

1. In Sentry, open **Settings**, then **Developer Settings**, and create a **New Internal Integration**. Give it **Read** on Organization, Project, Team, Issue & Event, Release and Alerts for a read-only connection, or **Read & Write** to use the actions above. Save it and copy its token (it starts with `sntryi_`). A personal token (**User Settings**, **Personal Tokens**, starting `sntryu_`) with the same scopes also works, limited to what your own role allows. Organization tokens (`sntrys_`) only cover CI uploads and are refused.
2. In Infrawrench, pick the **Region** your organization stores its data in: **US** or **DE** on sentry.io (Organization Settings shows the data storage location), or **Self-hosted**, in which case also enter the **Self-hosted URL** you open Sentry at.
3. Paste the token. The **Organization** picker then lists every organization the token can see in that region; pick one.

<insert [Sentry Add-account form with the region picker on US, the auth token filled in and the Organization picker open on the list of organizations] here>

**Check credentials** probes one read per capability and lists the scopes any missing capability needs; the template generator writes the exact scope list for the capabilities you keep.

The remaining fields are the prices used to estimate cost (see below). They start at Sentry's Team plan list prices, and you can change them at any time with **Edit credentials** on the account.

## Cost graphs

Sentry accounts on sentry.io feed [cost graphs & budgets](../features/cloud-costs.md) with daily costs by data category, tagged with the project:

| Category             | Usage                           | Default price             | Included each month |
| -------------------- | ------------------------------- | ------------------------- | ------------------- |
| Errors               | Accepted errors                 | $0.0003625 per error      | 50,000              |
| Spans                | Accepted spans                  | $0.000002 per span        | 5,000,000           |
| Transactions         | Accepted transactions (legacy)  | None: enter your rate     | 0                   |
| Replays              | Accepted session replays        | $0.00375 per replay       | 50                  |
| Attachments          | GB of attachments               | $0.3125 per GB            | 1 GB                |
| Logs                 | GB of logs                      | $0.50 per GB              | 5 GB                |
| Continuous profiling | Profile hours                   | $0.0315 per hour          | 0                   |
| UI profiling         | Profile hours                   | $0.25 per hour            | 0                   |
| Cron monitors        | Active monitors, current month  | $0.78 per monitor a month | 1                   |
| Uptime monitors      | Active monitors, current month  | $1.00 per monitor a month | 1                   |
| Plan                 | The plan's base fee, on the 1st | $26 a month               |                     |

- **These amounts are estimates.** Sentry's API reports usage but not prices, budgets or invoices, so Infrawrench prices accepted volume beyond each category's included amount at the rates in the account's credentials. The defaults are the Team plan's pay-as-you-go list prices; on Business, errors are $0.0011125 and spans $0.000004, and the plan fee is $80. If you reserved volume, add it to the included amount and enter your reserved rate. On the free Developer plan, set the plan fee to 0 and errors included to 5,000.
- A category is free until the month's accepted volume passes its allowance, so the first days of a month usually cost nothing. A month's rows add up to what that month bills at your rates. Filtered, rate-limited and dropped events are never billed.
- Cron and uptime monitors are priced from the monitors that are active (not paused) now, for the current month only, on the 1st of the month.
- Usage history reaches back 90 days, the furthest Sentry's usage API goes.
- A self-hosted Sentry has no bill, so it reports no cost. Its usage still shows on the organization's Metrics tab.

## Tips & limits

- The region must be the one your organization lives in: a token only sees organizations in the region you pick.
- Issues are listed from the 100 busiest unresolved ones in the organization, so a quiet project may show none; its detail page still shows its own unresolved count and top issues.
- Editing an alert sends the whole alert back to Sentry with only the name or interval changed. Build or change conditions and actions in Sentry.
- Cron and uptime monitors are listed as their own types rather than among the generic monitors. Uptime monitors use an API Sentry still marks experimental.
- Bastion egress for Sentry accounts allows only the sentry.io hosts (`sentry.io`, `us.sentry.io`, `de.sentry.io`), so a self-hosted Sentry has to be reachable without one.
- [Export to Terraform](../features/terraform-export.md) writes teams, projects and client keys as `sentry_team`, `sentry_project` and `sentry_key` resources for the `jianyuan/sentry` provider.
