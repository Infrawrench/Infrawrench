---
title: Better Stack
description: Manage Better Stack monitors, heartbeats, status pages, on-call calendars, incidents, escalation policies, Telemetry sources and dashboards, chart response times and source events, tail and query logs with SQL, and track daily cost per product.
sidebar_order: 50
---

Connect a Better Stack organization to manage uptime monitoring, incidents, status pages and Telemetry from Infrawrench, and to see what Better Stack costs you each day.

## What you can manage

**Uptime**

- **Monitors**: HTTP, keyword, status code, ping, TCP/UDP, DNS and mail server checks. Create them by picking the check type, regions, escalation policy and group. Edit the URL, name, check frequency, timeout, keyword and SSL verification. **Pause** and **Resume** them. The Metrics tab charts response times per checking region, and the detail page shows the last 30 days' availability.
- **Monitor groups** and **heartbeat groups**: create, rename, pause and resume every member at once, delete.
- **Heartbeats**: create them with their expected period and grace time, edit, pause, resume and delete. The **Ping URL** is a sensitive output you can export to a Kubernetes secret or a server as `BETTERSTACK_HEARTBEAT_URL`.
- **Status pages**: create them, and edit the company name, subdomain, custom domain, time zone, history length and whether they are published. Each page lists its **sections** (create, rename, reorder, delete), its **resources** (add a monitor or heartbeat to the page, change its public name, explanation and widget, remove it) and its **status reports**.
- **On-call calendars**: who is on call now and the shifts over the next 14 days. Create, rename and delete calendars.
- **Incidents** from the last 30 days: **Acknowledge**, **Resolve** or delete them, or open one by hand.
- **Escalation policies**: rename them and change how often they repeat. Create a simple policy that alerts whoever is on call at the severity you pick. Edit multi-step policies in Better Stack.

**Telemetry**

- **Sources**: create them for any supported platform and data region, rename them, change log and metrics retention, and **Pause ingesting** or **Resume ingesting**. The ingesting host and the source token are outputs you can export together as `BETTER_STACK_SOURCE_TOKEN` and `BETTER_STACK_INGESTING_HOST`. Once you turn on SQL access (see below), each source also has a **Logs** tab (so it works in [Log workspaces](../features/log-workspace.md)), a **SQL editor** and a Metrics tab charting events over time.
- **Source groups** and **dashboards**: create, rename and delete them. Change a dashboard's refresh interval and default time range.
- **Telemetry alerts**: rename them and change their operator, threshold and check period, or delete them.

**Organization**

- **Team members** with their role. You can remove members from here. When a global token covers several teams, members are listed per team, for the teams your monitors, heartbeats, on-call calendars and sources belong to, and someone in two teams appears once for each. Members of a team none of those belong to aren't listed, and members removed in Better Stack stay listed here until the token covers a single team again.

<insert [Better Stack monitor detail page showing the Pause button, 30-day availability and the Metrics tab with response times per region] here>

## Connect your organization

Use a **global API token**. In Better Stack, open **API tokens > Global API tokens** and create one. It covers Uptime, Telemetry, team members and cost data for every team in the organization. With a global token, create forms ask which team should own a new monitor, heartbeat, source and so on.

A team-scoped token also works:

1. Paste a team **Uptime API token** (API tokens > Team-based tokens) as the API token.
2. For that team's sources and dashboards, paste its **Telemetry API token** in the optional field.

Team tokens can't read cost data or team members, and only see their own team.

<insert [Better Stack Add-account form with the API Token field filled in and the optional Telemetry API Token left blank] here>

## Query logs with SQL

To see logs and run SQL, turn on SQL access once per team:

1. Open any source's page and click **Connect SQL access**.
2. A read-only connection named "Infrawrench (read-only SQL access)" appears in Better Stack under Telemetry, Integrations, Connections.

From then on, every source of that team has Logs, the SQL editor and the events chart. To revoke access, delete the connection in Better Stack.

In the SQL editor, a source's recent logs are `remote(t<team>_<table>_logs)`, older ones `s3Cluster(primary, t<team>_<table>_s3)`, and aggregated metrics `remote(t<team>_<table>_metrics)`. The editor fills in the right names for you.

## Costs

With a global API token, the Costs page shows what each Better Stack product cost per day, itemized by source, monitor plan, responder licenses and other billed items. These are the same numbers as the Usage page in your Better Stack billing settings. Today's figure is provisional and gets corrected later.

## Status

Open reports on [status.betterstack.com](https://status.betterstack.com) show on your Better Stack accounts: Uptime incidents on monitors, heartbeats and status pages, Telemetry incidents on sources and dashboards, and anything else on every resource.

## Export to Terraform

Monitors, monitor and heartbeat groups, heartbeats, status pages, status page sections and on-call calendars export as `BetterStackHQ/better-uptime` resources with their import ids. Escalation policies, status page resources and Telemetry objects (which use the separate Logtail provider) aren't exported.

## Limits

- Incidents from the last 30 days are listed.
- Response times cover the last day.
- Escalation policy steps are read-only here. Edit branching and multi-step policies in Better Stack.
