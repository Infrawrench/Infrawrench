---
title: Better Stack
description: Manage Better Stack monitors, heartbeats, status pages, on-call calendars, incidents, escalation policies, Telemetry sources and dashboards, chart response times and source events, tail and query logs with SQL, and track daily cost per product.
sidebar_order: 50
---

Connect a Better Stack organization to manage uptime monitoring, incidents, status pages and Telemetry from Infrawrench, and to see what Better Stack costs you each day.

## What you can manage

**Uptime**

- **Monitors**: HTTP, keyword, status code, ping, TCP/UDP, DNS and mail server checks. Create them with a picker for the check type, regions, escalation policy and group; edit the URL, name, check frequency, timeout, keyword and SSL verification; **Pause** and **Resume** them. The Metrics tab charts response times per checking region, and the detail page shows the last 30 days' availability.
- **Monitor groups** and **heartbeat groups**: create, rename, pause and resume every member at once, delete.
- **Heartbeats**: create them with their expected period and grace time, edit, pause, resume and delete. The **Ping URL** is a sensitive output you can export to a Kubernetes secret or a server as `BETTERSTACK_HEARTBEAT_URL`.
- **Status pages**: create them, and edit the company name, subdomain, custom domain, time zone, history length and whether they are published. Each page lists its **sections** (create, rename, reorder, delete), its **resources** (add a monitor or heartbeat to the page, change its public name, explanation and widget, remove it) and its **status reports**.
- **On-call calendars**: who is on call now and the shifts over the next 14 days. Create, rename and delete calendars.
- **Incidents** from the last 30 days: **Acknowledge**, **Resolve** or delete them, or open one by hand.
- **Escalation policies**: rename them and change how often they repeat; create a simple policy that alerts whoever is on call at the severity you pick. Edit multi-step policies in Better Stack.

**Telemetry**

- **Sources**: create them for any supported platform and data region, rename them, change log and metrics retention, and **Pause ingesting** or **Resume ingesting**. The ingesting host and the source token are outputs, exportable together as `BETTER_STACK_SOURCE_TOKEN` and `BETTER_STACK_INGESTING_HOST`. With SQL access connected (see below), each source also has a **Logs** tab (and so works in [Log workspaces](../features/log-workspace.md)), a **SQL editor** and a Metrics tab charting events over time.
- **Source groups** and **dashboards**: create, rename and delete them; change a dashboard's refresh interval and default time range.
- **Telemetry alerts**: rename them and change their operator, threshold and check period, or delete them.

**Organization**

- **Team members** with their role. Remove members from here.

<insert [Better Stack monitor detail page showing the Pause button, 30-day availability and the Metrics tab with response times per region] here>

## Credentials

Use a **global API token**: in Better Stack open **API tokens → Global API tokens** and create one. It covers Uptime, Telemetry, team members and cost data for every team in the organization.

A team-scoped token also works. Paste a team **Uptime API token** (API tokens → Team-based tokens) as the API token, and, for that team's sources and dashboards, its **Telemetry API token** in the optional field. Team tokens cannot read cost data or team members, and only see their own team.

With a global token, create forms ask which team should own a new monitor, heartbeat, source and so on.

<insert [Better Stack Add-account form with the API Token field filled in and the optional Telemetry API Token left blank] here>

## Logs and SQL

Better Stack serves logs and metrics through its read-only SQL API, which needs a connection with its own username and password. On a source's page, **Connect SQL access** creates one connection for the source's team (it appears as "Infrawrench (read-only SQL access)" under Telemetry, Integrations, Connections) and Infrawrench stores its password. From then on every source of that team has Logs, the SQL editor and the events chart. Delete the connection in Better Stack to revoke it.

In the SQL editor, a source's recent logs are `remote(t<team>_<table>_logs)`, older ones `s3Cluster(primary, t<team>_<table>_s3)`, and aggregated metrics `remote(t<team>_<table>_metrics)`; the editor pre-fills the right names.

## Costs

With a global API token, Better Stack's usage API reports what each product cost per day, itemized by source, monitor plan, responder licenses and other billed items, the same numbers as the Usage page in your billing settings. They appear on the Costs page by product, item and the item's name. Today's figure is provisional and is corrected on the next collection.

## Status

Open reports on [status.betterstack.com](https://status.betterstack.com) show on your Better Stack accounts: Uptime incidents on monitors, heartbeats and status pages, Telemetry incidents on sources and dashboards, and anything else on every resource.

## Export to Terraform

Monitors, monitor and heartbeat groups, heartbeats, status pages, status page sections and on-call calendars export as `BetterStackHQ/better-uptime` resources with their import ids. Escalation policies, status page resources and Telemetry objects (which use the separate Logtail provider) are not exported.

## Limits

- Incidents from the last 30 days are listed.
- Response times cover the last day, the window Better Stack's API returns.
- Escalation policy steps are shown read-only; edit branching and multi-step policies in Better Stack.
