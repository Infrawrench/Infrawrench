---
title: Honeycomb
description: Manage Honeycomb environments, datasets and their settings, columns, derived columns, triggers, SLOs and burn alerts, boards, markers, recipients and API keys, and chart event volume, latency, error rate and SLO compliance.
sidebar_order: 50
---

Connect a Honeycomb team to manage its setup and chart what your services send it, without leaving Infrawrench. It works alongside the Honeycomb UI: you still query and explore traces in Honeycomb.

## What you can manage

- **Environments**: every environment on the team, with its color, description and delete protection. Create, recolor and delete environments (Honeycomb doesn't let you rename one), and use **Connect environment** to give Infrawrench access to what's inside one (see [Connect your account](#connect-your-account)). The Metrics tab charts the events the environment stores, which is the volume Honeycomb bills on.
- **Datasets**: create datasets, edit the description, JSON unpacking depth and delete protection, and set the **dataset definitions**: the columns Honeycomb treats as trace id, span id, duration, error, service name, route and so on. The Metrics tab charts event volume, P50/P95/P99 of the duration column and the error rate.
- **Columns**: add a column before your events carry it, change its type, description or visibility, or delete one nobody sends any more.
- **Derived columns**: per dataset or environment-wide. Create them and edit the formula and description.
- **Triggers**: turn them on and off, and edit the threshold, how many times it must be exceeded, the frequency and when to notify. Create one with a simple query builder (calculation, column, filter, time range) or paste a full query specification. The Metrics tab runs the trigger's query over the selected range with the threshold drawn across it.
- **SLOs**: create one from a derived column you pick as the SLI, and edit the target and window. The Metrics tab charts the share of good events and the good and failed counts hour by hour.
- **Burn alerts**: on each SLO's page, for either exhaustion time or budget rate. Create and edit them.
- **Boards and board views**: create, rename and delete boards, and add, rename or delete a board's saved views.
- **Markers and marker settings**: add a marker (a deploy, say) by hand, edit its message, type and link, and set the color each marker type is drawn in.
- **Saved queries**: Honeycomb's named queries. Their Metrics tab charts the query over the selected range, with every calculation and the busiest breakdown groups as separate lines. Create one with the query builder, rename it, or delete it.
- **Recipients**: email, Slack, PagerDuty, webhook and Microsoft Teams recipients, with the triggers that notify each one. They're shared by every environment on the team.
- **Signals**: Honeycomb's anomaly detection per service. Turn them on or off and change their sensitivity.
- **API keys**: ingest and configuration keys for each environment. Create one with exactly the permissions it needs, rename, disable, enable or delete it. Honeycomb shows a key's secret only once. For keys created here, it's saved as the key's **Key** output, ready to export to a Kubernetes secret or a server.

<insert [Honeycomb dataset detail page showing the Dataset definitions section and the Metrics tab with Events, P99 duration and Error rate charts] here>

## Connect your account

Honeycomb has two kinds of key, and you can add either or both.

- A **management key** sees the whole team: every environment and every API key. In Honeycomb, open **Team Settings > API Keys > Management Keys** and create one with the `environments:read`, `environments:write`, `api-keys:read` and `api-keys:write` scopes (leave out the write scopes for a read-only account). Paste the **Key ID** and the **Secret**, or paste the joined `id:secret` value into the Key ID field.
- A **configuration key** sees one environment. In Honeycomb, open the environment's **Environment Settings > API Keys** and create a configuration key with **Manage Queries and Columns**, **Run Queries**, **Manage Triggers**, **Manage SLOs**, **Manage Public Boards**, **Manage Markers** and **Manage Recipients**. An ingest key won't work, since it can only send events.

A management key can't read anything inside an environment, so with one you need to connect each environment. Open the environment and click **Connect environment**: Infrawrench creates a configuration key called "Infrawrench" in that environment and saves it for you. Or edit the environment and paste a configuration key you made yourself. A configuration key on the account connects its own environment automatically.

Pick the **Region** your team is in: US if you sign in at ui.honeycomb.io, EU if at ui.eu1.honeycomb.io.

<insert [Honeycomb Add-account form with the Region set to US and the Management Key ID, Management Key Secret and Configuration Key fields filled in] here>

## Metrics

Charts need a Pro or Enterprise plan and the **Run Queries** permission. Honeycomb only answers queries over the last 7 days, so longer ranges are cut to 7 days. It also allows 10 query runs a minute per key, so if you see a rate-limit error, open charts one at a time. SLO charts aren't affected by either limit.

The dataset error rate is the share of events whose **Error** definition column is set. Set the dataset's Duration and Error columns under its definitions to see the latency and error charts.

## Costs

Honeycomb has no billing API, so Honeycomb spend doesn't appear on the Costs page. The environment's **Events stored** chart shows the volume your plan is measured in.

## Status

Open incidents on [status.honeycomb.io](https://status.honeycomb.io) show on your Honeycomb resources in the affected region (US1 or EU1).

## Export to Terraform

Environments, datasets, columns, derived columns, SLOs, marker settings and email, Slack, PagerDuty and webhook recipients export as `honeycombio/honeycombio` resources with their import ids. The Honeycomb provider takes one configuration key, so environment-scoped blocks apply to the environment whose key you give it. If you export several environments, split the file per environment. Triggers, burn alerts and boards aren't exported.

## Tips and limits

- Create forms opened from an environment's page list that environment's datasets. Opened from the sidebar, they list the environments the account's own keys can reach.
- Only the most recent 100 markers per dataset are listed.
- Compliance, remaining budget and burn rate on an SLO need Honeycomb's detailed SLO reporting, which is Enterprise-only. On other plans those fields stay empty.
- Turn off delete protection (edit the environment or dataset) before deleting it.
- Honeycomb Classic teams have a single environment without a slug. It shows as "classic".
