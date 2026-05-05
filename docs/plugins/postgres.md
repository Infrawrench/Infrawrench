---
title: PostgreSQL
description: Add a Postgres account and get a live SQL editor with schema introspection.
sidebar_order: 10
---

## What you can manage

- Databases, schemas, tables (browse).
- Run arbitrary SQL — see [SQL editor](../features/sql-editor.md).
- Peer integration: managed Postgres from DigitalOcean and Neon can be linked via [output reference](../core-concepts/output-references.md).

## Credentials

Paste a full connection string:

```
postgresql://user:password@host:5432/dbname
```

Or use an output reference from a DigitalOcean managed database or a Neon branch.

<insert [Postgres Add-account form with connection string and output-ref toggle] here>

## Notable flows

- **SQL editor** with autocomplete from `information_schema`.
- **SSH tunnel** support — if the host is only reachable via a bastion, set up an [SSH tunnel](../features/ssh-tunnels.md) and point the connection at `127.0.0.1`.

## Tips & limits

- SSL mode defaults to `require` when the URL does not specify. Append `?sslmode=disable` if you know what you are doing.
- Very large result sets are trimmed in the grid at 10k rows. Export to CSV or narrow your `LIMIT`.
