---
title: Honeycomb
description: Manage Honeycomb environments, datasets and their settings, columns, derived columns, triggers, SLOs and burn alerts, boards, markers, recipients and API keys, and chart event volume, latency, error rate and SLO compliance.
sidebar_order: 50
---

Connect a Honeycomb team to manage how it is configured and to chart what your services send it, without leaving Infrawrench. Everything here works alongside the Honeycomb UI rather than replacing it: you still query and explore traces in Honeycomb.

## What you can manage

- **Environments**: every environment on the team, with its color, description and delete protection. Create, rename, recolor and delete environments, and **Connect environment** to give Infrawrench access to what is inside one (see Credentials). The Metrics tab charts the events the environment stores, the volume Honeycomb bills on.
- **Datasets**: create datasets, edit the description, JSON unpacking depth and delete protection, and set the **dataset definitions**: the columns Honeycomb reads as trace id, span id, duration, error, service name, route and so on. The Metrics tab charts event volume, P50/P95/P99 of the duration column and the error rate.
- **Columns**: add a column before your events carry it, change its type, description or visibility, or delete one nobody sends any more.
- **Derived columns**: per dataset or environment-wide. Create them and edit the formula and description.
- **Triggers**: enable and disable them, and edit the threshold, how many times it must be exceeded, the frequency and when to notify. Create one with a simple query builder (calculation, column, filter, time range) or paste a full query specification. The Metrics tab re-runs the trigger's query over the selected range with the threshold drawn across it.
- **SLOs**: create one from a derived column you pick as the SLI, and edit the target and window. The Metrics tab charts the share of good events and the good and failed counts hour by hour.
- **Burn alerts**: on each SLO's page, for either exhaustion time or budget rate. Create and edit them.
- **Boards and board views**: create, rename and delete boards, and add, rename or delete the saved views of a board.
- **Markers and marker settings**: add a marker (a deploy, say) by hand, edit its message, type and link, and set the color each marker type is drawn in.
- **Saved queries**: Honeycomb's named queries. Their Metrics tab charts the query over the selected range, every calculation and the busiest breakdown groups as separate lines. Create one with the query builder, rename it, or delete it.
- **Recipients**: email, Slack, PagerDuty, webhook and Microsoft Teams recipients, with the triggers that notify each one. They are shared by every environment on the team.
- **Signals**: Honeycomb's anomaly detection per service. Turn them on or off and change their sensitivity.
- **API keys**: ingest and configuration keys for each environment. Create one with exactly the permissions it needs, rename, disable, enable or delete it. Honeycomb shows a key's secret only once; for keys created here it is kept as the key's **Key** output, ready to export to a Kubernetes secret or a server.

<insert [Honeycomb dataset detail page showing the Dataset definitions section and the Metrics tab with Events, P99 duration and Error rate charts] here>

## Credentials

Honeycomb has two kinds of key, and the account can take either or both.

- A **management key** sees the whole team: every environment and every API key. In Honeycomb open **Team Settings → API Keys → Management Keys** and create one with the `environments:read`, `environments:write`, `api-keys:read` and `api-keys:write` scopes (leave out the write scopes for a read-only account). Paste the **Key ID** and the **Secret**, or paste the joined `id:secret` value into the Key ID field.
- A **configuration key** sees one environment. In Honeycomb open the environment's **Environment Settings → API Keys** and create a configuration key with **Manage Queries and Columns**, **Run Queries**, **Manage Triggers**, **Manage SLOs**, **Manage Public Boards**, **Manage Markers** and **Manage Recipients**. An ingest key will not work: it can only send events.

A management key cannot read anything inside an environment, so with one each environment needs connecting. Open the environment and use **Connect environment**: Infrawrench creates a configuration key called "Infrawrench" in that environment and stores it for you. Or edit the environment and paste a configuration key you made yourself. A configuration key on the account connects its own environment automatically.

Pick the **Region** your team is in: US if you sign in at ui.honeycomb.io, EU if at ui.eu1.honeycomb.io.

<insert [Honeycomb Add-account form with the Region set to US and the Management Key ID, Management Key Secret and Configuration Key fields filled in] here>

## Metrics

Charts come from Honeycomb's Query Data API, which is part of the Pro and Enterprise plans and needs the **Run Queries** permission. Honeycomb only answers queries over the last 7 days, so longer ranges are cut to 7 days, and it allows 10 query runs a minute per key, so open charts one at a time if you see a rate-limit error. SLO charts read SLO history instead and are not affected by either limit.

The dataset error rate is the share of events whose **Error** definition column is set. Set the dataset's Duration and Error columns under its definitions for the latency and error charts to appear.

## Costs

Honeycomb has no billing API, so Honeycomb spend does not appear on the Costs page. The environment's **Events stored** chart shows the volume your plan is measured in.

## Status

Open incidents on [status.honeycomb.io](https://status.honeycomb.io) show on the Honeycomb resources in the affected region (US1 or EU1).

## Export to Terraform

Environments, datasets, columns, derived columns, SLOs, marker settings and email, Slack, PagerDuty and webhook recipients export as `honeycombio/honeycombio` resources with their import ids. The Honeycomb provider takes one configuration key, so environment-scoped blocks apply to the environment whose key you give it; split the file per environment when you export several. Triggers, burn alerts and boards are not exported because their blocks need the full query and panel definitions.

## Limits

- Create forms opened from an environment's page list that environment's datasets. Opened from the sidebar, they list the environments the account's own keys can reach.
- Markers are events rather than configuration, so only the most recent 100 per dataset are listed.
- Compliance, remaining budget and burn rate on an SLO come from Honeycomb's detailed SLO reporting, which is Enterprise-only; on other plans those fields stay empty.
- Delete protection must be turned off (edit the environment or dataset) before Honeycomb lets you delete it.
- Honeycomb Classic teams have a single environment without a slug; it shows as "classic".
