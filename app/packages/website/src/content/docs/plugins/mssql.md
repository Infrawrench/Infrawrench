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

![SQL Server Add-account form with the connection string field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mssql/add-account.png)

## Notable flows

- **SQL editor** with a schema browser introspected from `INFORMATION_SCHEMA`.
- **SSH tunnel** support — if the server only listens on a bastion's loopback, use **Connect service via SSH** on that bastion instead of adding an account here; it creates the account for you. See [SSH tunnels](../features/ssh-tunnels.md).

## Tips & limits

- `encrypt=true` is on by default in modern drivers; flip `trustServerCertificate=true` only if your server uses a self-signed cert and you understand the risk.
- Very large result sets are trimmed in the grid at 10k rows — narrow your query or export to CSV.
