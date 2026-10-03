---
title: ClickHouse
description: Manage ClickHouse Cloud services, ClickPipes, backups, Managed Postgres, API keys and members, and query HTTP interface endpoints.
sidebar_order: 19
---

## What you can manage

- **Services**: create with a provider-filtered region picker and release channel, start / stop, and edit name, release channel, IP access list, autoscaling mode, replica count or replica band, memory per replica, and idle scaling
- **Backups** of each service (status, type, size, duration), counted as protection for the service on the backup coverage view
- **ClickPipes**: list every pipe per service with its source kind and destination, start / stop, resync (database CDC pipes), rename, scale replicas or concurrency, and delete
- **Managed Postgres** (beta in the Cloud API): create with provider, region, Postgres version, instance size and high-availability pickers; edit name, size and HA; restart; delete; time-series metrics
- **API keys**: rename, enable / disable, delete, with roles, last use and expiry (keys show on the expiry radar and the access review)
- **Members**: list with their roles, remove from the organization
- HTTP interface SQL editor against any ClickHouse endpoint

## Credentials

ClickHouse accounts hold two complementary credential sets in a single record — the Cloud API for service management plus a direct connection for SQL queries:

**Cloud API** (for create / start / stop on ClickHouse Cloud)

- **Cloud API Key ID** and **Cloud API Key Secret** — generate at ClickHouse Cloud → API Keys.
- **Organization ID** — your ClickHouse Cloud organization.

**SQL connection** (optional — for the SQL editor, works against Cloud or self-hosted)

- **Service Hostname (for SQL)** — the HTTPS host of the ClickHouse service. Leave blank to skip SQL and use the account for service management only.
- **SQL Username** and **SQL Password**.

![ClickHouse Add-account form showing the Cloud API and SQL connection field groups](https://agent-assets.infrawrench.com/docs-screenshots/plugins/clickhouse/add-account.png)

## Notable flows

- **SQL editor** — streaming results for large queries.
- **Service creation** on ClickHouse Cloud with provider / region / replica options. The region list matches the regions the Cloud API accepts and narrows to the provider you pick.
- **Service settings**: the Edit button sends name, release channel and IP access list changes to the service, and scaling changes to the replica scaling endpoint. Vertical autoscaling uses a fixed replica count; horizontal autoscaling uses the min / max replica band. Edit the IP access list as a comma-separated list; Infrawrench works out what to add and remove. A service whose list contains `0.0.0.0/0` is flagged on the security posture view.
- **Backup schedule and upgrade window**: open a service to see its backup schedule, retention and maintenance window. The **Backup schedule** and **Upgrade window** buttons change them (custom backup schedules and upgrade windows depend on your ClickHouse Cloud plan); **Clear upgrade window** hands scheduling back to ClickHouse.
- **Metrics**: the service Metrics tab reads the Cloud Prometheus endpoint (running queries, connections, memory, MergeTree size / rows / parts, replica delay, and cumulative query / insert counters). The endpoint reports current values only, so the chart fills in as Infrawrench samples it. Managed Postgres metrics come from its own time-series endpoint and cover the selected range.
- **ClickPipes metrics**: a ClickPipe's Metrics tab picks its own `ClickPipes_*` counters out of the parent service's Prometheus scrape: fetched and sent events, fetched and sent bytes (raw and compressed), and errors. These are lifetime counters, so the slope of the line is the throughput.
- **Logs**: a service's Logs tab lists its entries from the organization activity log over the last 30 days (starts, stops, idling and waking, scaling and setting changes, backups, upgrades), each with who did it and from where. A Managed Postgres service's Logs tab shows the Postgres server log for the last 24 hours, with a dropdown to narrow it to `ERROR`, `WARNING` or `FATAL` entries.
- **Managed Postgres connection details**: ClickHouse Cloud returns the superuser password and connection string only when a service is created, so Infrawrench keeps them as the **Connection String** output for services created here. For other services, reset the password in the ClickHouse console.
- **ClickPipes and API keys are created in the ClickHouse console**: a pipe needs source credentials and a column mapping, and a new key's secret is only shown once. Everything after creation can be done here.
- **Secret export** is not yet supported for ClickHouse — pull connection strings manually.

## Tips & limits

- Very large result sets stream into the grid; expect high memory use on the client for 10M+ row selects. Use `LIMIT` or export.
- Cloud services scale to zero; a first query after idle can take 10–20 seconds to wake.

## Cost graphs

ClickHouse Cloud organizations feed [cost graphs & budgets](../features/cloud-costs.md) via the organization `usageCost` API — daily costs per service with compute / storage / backup / data-transfer / ClickPipes breakdowns.

- A read-only (Developer role) Cloud API key is sufficient.
- Amounts are ClickHouse Credits at the 1 CHC = $1 **list price** — negotiated committed-spend discounts are not reflected.

## Credits and quotas

- **Credits**: active prepaid and trial credit balances feed the credit runway view, with the amount granted and the expiry date of each balance. Reading them needs billing view access on the API key.
- **Quotas**: organization quotas that report usage (services, Managed Postgres services, API keys) feed the quota view. ClickHouse Cloud publishes only a handful of quotas, so the list is partial by design.

## API key permissions

Listing services and costs works with a Developer key. Editing services, managing ClickPipes, backup schedules and upgrade windows, Managed Postgres, API keys and members needs an Admin key (or a custom role with those permissions).
