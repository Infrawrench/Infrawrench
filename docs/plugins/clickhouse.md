---
title: ClickHouse
description: Manage ClickHouse Cloud services and query HTTP interface endpoints.
sidebar_order: 19
---

## What you can manage

- ClickHouse Cloud services (create with provider / region / replica picker, start / stop)
- HTTP interface SQL editor against any ClickHouse endpoint

## Credentials

Two separate flows:

- **ClickHouse Cloud** — API key ID + secret from the ClickHouse Cloud console.
- **Direct HTTP** — host, port, username, password for any ClickHouse server.

<insert [ClickHouse Add-account form with the two modes side by side] here>

## Notable flows

- **SQL editor** — streaming results for large queries.
- **Service creation** on ClickHouse Cloud with provider / region / replica options.
- **Secret export** is not yet supported for ClickHouse — pull connection strings manually.

## Tips & limits

- Very large result sets stream into the grid; expect high memory use on the client for 10M+ row selects. Use `LIMIT` or export.
- Cloud services scale to zero; a first query after idle can take 10–20 seconds to wake.
