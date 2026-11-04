---
title: InfluxDB Cloud
description: Manage InfluxDB Cloud and Cloud Serverless buckets, tokens, tasks and alerts, query buckets with InfluxQL or Flux, and manage Cloud Dedicated databases and tokens.
sidebar_order: 50
---

Connect InfluxDB Cloud or Cloud Serverless to manage buckets, tokens, tasks and alerts and to query your data. You can also manage an InfluxDB 3 Cloud Dedicated cluster, on the same account or on its own.

## What you can manage

- **Organization**: storage engine and plan limits (buckets, longest retention, tasks, checks, read and write rate, series cardinality).
- **Buckets**: create, rename, describe, change **retention** (in days, 0 keeps data forever), delete. Each bucket shows the storage it uses.
- **Query tab** on every bucket: write InfluxQL (`SELECT … FROM measurement`), or Flux when the text uses pipes (`from(bucket: …) |> range(…)`). The sidebar lists measurements with their tag and field keys.
- **API tokens**: create one with read and write access to the buckets you pick plus any other permissions (pick them all for an all-access token). The token is shown once, in the new resource's outputs. You can also activate, deactivate, change the description and delete.
- **Tasks**: create one with Flux and an every or cron schedule. Edit the name, schedule and description, **Edit Flux**, **Run now**, activate or deactivate, delete. The Logs tab shows the task's run log. Sleep/wake schedules can turn tasks on and off.
- **Checks, notification rules and notification endpoints**: rename, describe, activate or deactivate, delete. Create these in the InfluxDB UI, which has the query builder.
- **Dashboards**: create, rename, describe, delete. **Telegraf configurations**: list and delete.
- **Cloud Dedicated databases**: create with retention, table and column limits, edit those, delete.
- **Cloud Dedicated database tokens**: create with read and write access to the databases you pick (or all of them) and an optional expiry, edit the description, delete.

<insert [InfluxDB Cloud bucket detail page with the query tab open, showing an InfluxQL query and its results] here>

## Connect your account

For InfluxDB Cloud or Cloud Serverless:

1. **Region**: the region in your InfluxDB Cloud URL (for example `us-east-1-1` for `https://us-east-1-1.aws.cloud2.influxdata.com`).
2. **API Token**: in the InfluxDB Cloud UI, open **Load Data > API Tokens > Generate API Token > All Access API Token**. A custom token works too, limited to what it allows.
3. **Organization**: pick it from the list the token can see.

For InfluxDB 3 Cloud Dedicated (under **Advanced options**):

- **Account ID** and **Cluster ID**, from your `influxctl` configuration and `influxctl cluster list`.
- A **management token** from `influxctl management create`.

Fill in either set, or both.

<insert [InfluxDB Cloud Add-account form with the Region, API Token and Organization fields, and the Advanced options section expanded] here>

## Metrics and quotas

- Bucket Metrics show storage over time. The organization's Metrics show every usage series InfluxDB Cloud reports (storage across buckets and anything else your plan meters).
- Plan limits that InfluxDB gives as numbers (buckets, tasks, checks, dashboards, notification rules) show on the **Quotas** view with how many you use.

## Savings and security

- Inactive API tokens show under **Potential savings**. Tokens also show on the access review, with all-access tokens marked as admins.

## Status

Incidents from [status.influxdata.com](https://status.influxdata.com) show on resources in the affected region. Cloud Dedicated incidents show on Dedicated databases and tokens.

## Tips and limits

- InfluxDB Cloud has no billing API, so spend doesn't show in cost graphs.
- If your organization can't use tasks, checks or notification rules (Cloud Serverless organizations, for example), those lists stay empty.
- InfluxDB has no official Terraform provider, so there's no Terraform export.
- The newer InfluxDB 3 Cloud (single-instance) API isn't covered yet.
