---
title: SQL Server
description: Connect to a Microsoft SQL Server database and run queries from the SQL editor.
sidebar_order: 12
---

## What you can manage

- Browse databases (and the tables, views, and stored procedures inside them).
- Run arbitrary T-SQL — see [SQL editor](../features/sql-editor.md).

## Credentials

A single **Connection String** field — a SQL Server connection URI:

```
mssql://user:password@host:1433/dbname?encrypt=true&trustServerCertificate=false
```

<insert [SQL Server Add-account form with the connection string field] here>

## Notable flows

- **SQL editor** with autocomplete from `INFORMATION_SCHEMA`.
- **SSH tunnel** support — if the server is only reachable via a bastion, set up an [SSH tunnel](../features/ssh-tunnels.md) and point the connection string at `127.0.0.1`.

## Tips & limits

- `encrypt=true` is on by default in modern drivers; flip `trustServerCertificate=true` only if your server uses a self-signed cert and you understand the risk.
- Very large result sets are trimmed in the grid at 10k rows — narrow your query or export to CSV.
