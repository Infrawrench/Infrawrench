---
title: MySQL
description: Add a MySQL or MariaDB account and use the in-app SQL editor.
sidebar_order: 11
---

Connect a MySQL or MariaDB database to browse it and run SQL.

## What you can manage

- Databases and tables (browse).
- Any SQL you like in the [SQL editor](../features/sql-editor.md).
- Vitess-backed MySQL through the [PlanetScale plugin](./planetscale.md).

## Connect a database

Paste a connection string:

```
mysql://user:password@host:3306/dbname
```

Or pick an output from a PlanetScale branch or a managed MySQL resource.

![MySQL Add-account form with connection string field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mysql/add-account.png)

## Run queries

- The **SQL editor** comes with a schema browser, so you can see tables and columns while you write.
- If the host is private, connect through an **SSH tunnel**.

## Tips and limits

- MariaDB works too, but features that rely on MySQL 8 specifics may not be available.
- On PlanetScale (Vitess), cross-shard joins can fail. You'll see the raw error from the database.
