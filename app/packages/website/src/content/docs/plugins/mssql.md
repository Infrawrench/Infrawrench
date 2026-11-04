---
title: SQL Server
description: Connect to a Microsoft SQL Server database and run queries from the SQL editor.
sidebar_order: 12
---

Connect a Microsoft SQL Server database to browse it and run T-SQL.

## What you can manage

- Databases, plus the tables, views and stored procedures inside them.
- Any T-SQL you like in the [SQL editor](../features/sql-editor.md).

## Connect a database

There is one field, **Connection String**. Paste a SQL Server connection URI:

```
mssql://user:password@host:1433/dbname?encrypt=true&trustServerCertificate=false
```

![SQL Server Add-account form with the connection string field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mssql/add-account.png)

## Run queries and reach private servers

- The **SQL editor** comes with a schema browser, so you can see tables and columns while you write.
- **SSH tunnels** are supported. If the server only listens on a bastion's loopback, don't add an account here. Use **Connect service via SSH** on that bastion instead, and it creates the account for you. See [SSH tunnels](../features/ssh-tunnels.md).

## Tips and limits

- `encrypt=true` is on by default in modern drivers. Only set `trustServerCertificate=true` if your server uses a self-signed cert and you understand the risk.
- The results grid stops at 10k rows. Narrow your query or export to CSV.
