---
title: InfluxDB Cloud
description: Manage InfluxDB Cloud and Cloud Serverless buckets, tokens, tasks and alerts, query buckets with InfluxQL or Flux, and manage Cloud Dedicated databases and tokens.
sidebar_order: 50
---

The InfluxDB Cloud plugin talks to the InfluxDB v2 API of your organization's region, which both InfluxDB Cloud (TSM) and InfluxDB Cloud Serverless use. It can also manage an InfluxDB 3 Cloud Dedicated cluster through its Management API, on the same account or on its own.

## What you can manage

- **Organization**: storage engine and plan limits (buckets, longest retention, tasks, checks, read and write rate, series cardinality).
- **Buckets**: create, rename, describe, change **retention** (in days, 0 keeps data forever), delete. Storage used comes with each bucket.
- **Query tab** on every bucket: InfluxQL (`SELECT … FROM measurement`) through the v1 compatibility API, or Flux when the text pipes (`from(bucket: …) |> range(…)`). The sidebar lists measurements with their tag and field keys.
- **API tokens**: create with read and write access to picked buckets plus any other permissions (pick them all for an all-access token). The token is shown once, in the new resource's outputs. Activate, deactivate, change the description, delete.
- **Tasks**: create with Flux and an every or cron schedule, edit the name, schedule and description, **Edit Flux**, **Run now**, activate or deactivate, delete. The Logs tab shows the task's run log. Sleep/wake schedules can activate and deactivate tasks.
- **Checks, notification rules and notification endpoints**: rename, describe, activate or deactivate, delete. Create these in the InfluxDB UI, where the query builder lives.
- **Dashboards**: create, rename, describe, delete. **Telegraf configurations**: list and delete.
- **Cloud Dedicated databases**: create with retention, table and column limits, edit those, delete.
- **Cloud Dedicated database tokens**: create with read and write access to picked databases (or all of them) and an optional expiry, edit the description, delete.

<insert [InfluxDB Cloud bucket detail page with the query tab open, showing an InfluxQL query and its results] here>

## Credentials

For InfluxDB Cloud or Cloud Serverless:

1. **Region**: the region in your InfluxDB Cloud URL (for example `us-east-1-1` for `https://us-east-1-1.aws.cloud2.influxdata.com`).
2. **API Token**: in the InfluxDB Cloud UI open **Load Data → API Tokens → Generate API Token → All Access API Token**. A custom token works too, limited to what it grants.
3. **Organization**: picked from the list the token can see.

For InfluxDB 3 Cloud Dedicated (under **Advanced options**):

- **Account ID** and **Cluster ID**, from your `influxctl` configuration and `influxctl cluster list`.
- A **management token** from `influxctl management create`.

Fill in either set, or both.

<insert [InfluxDB Cloud Add-account form with the Region, API Token and Organization fields, and the Advanced options section expanded] here>

## Metrics and quotas

- Bucket Metrics show storage over time, and the organization's Metrics show every usage series InfluxDB Cloud reports (storage across buckets and whatever else your plan meters), from the organization usage API.
- Plan limits that InfluxDB states as numbers (buckets, tasks, checks, dashboards, notification rules) appear on the **Quotas** view with how many you use.

## Savings and security

- Inactive API tokens show under **Potential savings**, and tokens appear on the access review, with all-access tokens marked as admins.

## Status

Incidents from [status.influxdata.com](https://status.influxdata.com) appear against the resources in the affected region; Cloud Dedicated incidents against Dedicated databases and tokens.

## Tips & limits

- InfluxDB Cloud has no billing API, so spend does not appear in cost graphs.
- Where an organization cannot use tasks, checks or notification rules (Cloud Serverless organizations, for example), those lists stay empty.
- InfluxDB has no official Terraform provider, so there is no Terraform export.
- The newer InfluxDB 3 Cloud (single-instance) API is not covered yet.
