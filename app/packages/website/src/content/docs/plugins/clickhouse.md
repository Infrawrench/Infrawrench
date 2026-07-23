---
title: ClickHouse
description: Manage ClickHouse Cloud services and query HTTP interface endpoints.
sidebar_order: 19
---

## What you can manage

- ClickHouse Cloud services (create with provider / region / replica picker, start / stop)
- HTTP interface SQL editor against any ClickHouse endpoint

## Credentials

ClickHouse accounts hold two complementary credential sets in a single record — the Cloud API for service management plus a direct connection for SQL queries:

**Cloud API** (for create / start / stop on ClickHouse Cloud)

- **Cloud API Key ID** and **Cloud API Key Secret** — generate at ClickHouse Cloud → API Keys.
- **Organization ID** — your ClickHouse Cloud organization.

**SQL connection** (for the SQL editor — works against Cloud or self-hosted)

- **Service Hostname (for SQL)** — the HTTPS host of the ClickHouse service.
- **SQL Username** and **SQL Password**.

<insert [ClickHouse Add-account form showing the Cloud API and SQL connection field groups] here>

## Notable flows

- **SQL editor** — streaming results for large queries.
- **Service creation** on ClickHouse Cloud with provider / region / replica options.
- **Secret export** is not yet supported for ClickHouse — pull connection strings manually.

## Tips & limits

- Very large result sets stream into the grid; expect high memory use on the client for 10M+ row selects. Use `LIMIT` or export.
- Cloud services scale to zero; a first query after idle can take 10–20 seconds to wake.

## Cost graphs

ClickHouse Cloud organizations feed [cost graphs & budgets](../features/cloud-costs.md) via the organization `usageCost` API — daily costs per service with compute / storage / backup / data-transfer / ClickPipes breakdowns.

- A read-only (Developer role) Cloud API key is sufficient.
- Amounts are ClickHouse Credits at the 1 CHC = $1 **list price** — negotiated committed-spend discounts are not reflected.
