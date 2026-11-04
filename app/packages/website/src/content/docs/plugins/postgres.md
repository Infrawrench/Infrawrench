---
title: PostgreSQL
description: Add a Postgres account and get a live SQL editor with a schema browser.
sidebar_order: 10
---

## What you can manage

- Browse databases, schemas and tables.
- Run any SQL in the [SQL editor](../features/sql-editor.md).
- Link managed Postgres from DigitalOcean and Neon with an [output reference](../core-concepts/output-references.md).

## Connect a database

Paste a full connection string:

```
postgresql://user:password@host:5432/dbname
```

There's one more field, **CA Certificate**, under **Advanced options** at the bottom of the form. It's optional. You only need it if the server uses a vendor-managed CA your system doesn't already trust.

For a managed database you already have in Infrawrench, don't add an account here. Open the database and use its **PostgreSQL** tab instead. The connection string and CA certificate come straight from the database as an [output reference](../core-concepts/output-references.md). That covers RDS instances and clusters, Redshift, Cloud SQL, AlloyDB, Azure Database for PostgreSQL, DigitalOcean and Scaleway managed databases, OVH managed DBs, and Neon projects, branches and databases.

![Postgres Add-account form with the Connection String field and the optional CA Certificate field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/postgres/add-account.png)

## Things you can do

- **SQL editor** with a schema browser.
- **SSH tunnel**: if the database only listens on a bastion's loopback, use **Connect service via SSH** on that bastion instead of adding an account here. It creates the account for you. See [SSH tunnels](../features/ssh-tunnels.md).

## Tips & limits

- SSL mode is `require` unless your URL says otherwise. Add `?sslmode=disable` only if you're sure.
- The results grid stops at 10k rows. Export to CSV or tighten your `LIMIT`.
- In the cloud app, connection strings that point at certificate files (`sslrootcert`, `sslcert`, `sslkey`) are refused, since those files would be looked for on the Infrawrench server, not your machine. Paste the CA into the **CA Certificate** field instead. Client-certificate (mutual TLS) logins need the desktop app.
