---
title: MySQL
description: Add a MySQL or MariaDB account and use the in-app SQL editor.
sidebar_order: 11
---

## What you can manage

- Databases, tables (browse).
- Arbitrary SQL via the [SQL editor](../features/sql-editor.md).
- Peer integration with the [PlanetScale plugin](./planetscale.md) for Vitess-backed MySQL.

## Credentials

Paste a connection string:

```
mysql://user:password@host:3306/dbname
```

Or reference an output from a PlanetScale branch or a managed MySQL resource.

![MySQL Add-account form with connection string field](https://agent-assets.infrawrench.com/docs/screenshots/plugins/mysql-add-account.png)

## Notable flows

- **SQL editor** with autocomplete from `information_schema`.
- **SSH tunnel** if the host is private.

## Tips & limits

- MariaDB works with the same driver; features that require MySQL 8 specifics may not be available.
- For PlanetScale (Vitess), cross-shard joins can fail — infrawrench surfaces the raw error.
