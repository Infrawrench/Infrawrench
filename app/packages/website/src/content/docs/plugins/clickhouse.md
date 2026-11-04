---
title: ClickHouse
description: Manage ClickHouse Cloud services, ClickPipes, backups, Managed Postgres, API keys and members, and query HTTP interface endpoints.
sidebar_order: 19
---

Connect ClickHouse Cloud to manage services, pipes and backups, and run SQL against any ClickHouse endpoint, Cloud or self-hosted.

## What you can manage

- **Services**: create with a region picker filtered by provider and a release channel, start and stop, and edit name, release channel, IP access list, autoscaling mode, replica count or replica band, memory per replica, and idle scaling
- **Backups** of each service (status, type, size, duration), counted as protection for the service on the backup coverage view
- **ClickPipes**: every pipe per service with its source kind and destination. Start and stop, resync (database CDC pipes), rename, scale replicas or concurrency, and delete
- **Managed Postgres** (beta in the Cloud API): create with provider, region, Postgres version, instance size and high-availability pickers. Edit name, size and HA, restart, delete, and see time-series metrics
- **API keys**: rename, enable and disable, delete, with roles, last use and expiry (keys show on the expiry radar and the access review)
- **Members**: list with their roles, remove from the organization
- A SQL editor for any ClickHouse HTTP endpoint

## Connect your account

A ClickHouse account has two sets of credentials: the Cloud API for managing services, and an optional direct connection for SQL.

**Cloud API** (to create, start and stop services on ClickHouse Cloud)

- **Cloud API Key ID** and **Cloud API Key Secret**: generate them at ClickHouse Cloud > API Keys.
- **Organization ID**: your ClickHouse Cloud organization.

**SQL connection** (optional, for the SQL editor, works against Cloud or self-hosted)

- **Service Hostname (for SQL)**: the HTTPS host of the ClickHouse service. Leave it blank to skip SQL and use the account for service management only.
- **SQL Username** and **SQL Password**.

![ClickHouse Add-account form showing the Cloud API and SQL connection field groups](https://agent-assets.infrawrench.com/docs-screenshots/plugins/clickhouse/add-account.png)

### API key permissions

A Developer key is enough to list services and see costs. Editing services, managing ClickPipes, backup schedules and upgrade windows, Managed Postgres, API keys and members needs an Admin key (or a custom role with those permissions).

## Common tasks

- **Run SQL**: results stream in, so large queries start showing rows quickly.
- **Create a service** on ClickHouse Cloud with provider, region and replica options. The region list narrows to the provider you pick.
- **Change service settings** with **Edit**. Vertical autoscaling uses a fixed replica count. Horizontal autoscaling uses a min and max replica band. Enter the IP access list as a comma-separated list. A service whose list contains `0.0.0.0/0` is flagged on the security posture view.
- **Set the backup schedule and upgrade window**: open a service to see its backup schedule, retention and maintenance window. Use **Backup schedule** and **Upgrade window** to change them (custom backup schedules and upgrade windows depend on your ClickHouse Cloud plan). **Clear upgrade window** hands scheduling back to ClickHouse.
- **Metrics**: the service Metrics tab shows running queries, connections, memory, MergeTree size, rows and parts, replica delay, and cumulative query and insert counters. These are current values, so the chart fills in over time. Managed Postgres metrics cover the selected range.
- **ClickPipes metrics**: a ClickPipe's Metrics tab shows fetched and sent events, fetched and sent bytes (raw and compressed), and errors. These are lifetime counters, so the slope of the line is the throughput.
- **Logs**: a service's Logs tab lists its activity over the last 30 days (starts, stops, idling and waking, scaling and setting changes, backups, upgrades), each with who did it and from where. A Managed Postgres service's Logs tab shows the Postgres server log for the last 24 hours, with a dropdown to narrow it to `ERROR`, `WARNING` or `FATAL` entries.
- **Managed Postgres connection details**: ClickHouse Cloud only returns the superuser password and connection string when a service is created. For services you create here, they are saved as the **Connection String** output. For other services, reset the password in the ClickHouse console.
- **Create ClickPipes and API keys in the ClickHouse console.** A pipe needs source credentials and a column mapping, and a new key's secret is only shown once. You can do everything after creation here.
- **Secret export** isn't supported for ClickHouse yet. Copy connection strings by hand.

## Tips & limits

- Very large result sets stream into the grid, and 10M+ row selects use a lot of memory on your machine. Use `LIMIT` or export.
- Cloud services scale to zero. The first query after idle can take 10 to 20 seconds while the service wakes.

## Cost graphs

ClickHouse Cloud organizations show up in [cost graphs & budgets](../features/cloud-costs.md) with daily costs per service, broken down into compute, storage, backup, data transfer and ClickPipes.

- A read-only (Developer role) Cloud API key is enough.
- Amounts are ClickHouse Credits at the 1 CHC = $1 **list price**. Negotiated committed-spend discounts aren't included.

## Credits and quotas

- **Credits**: active prepaid and trial credit balances appear in the credit runway view, with the amount granted and the expiry date of each balance. This needs billing view access on the API key.
- **Quotas**: organization quotas that report usage (services, Managed Postgres services, API keys) appear in the quota view. ClickHouse Cloud only publishes a few quotas, so the list is partial.
