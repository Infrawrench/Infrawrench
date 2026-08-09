---
title: SQL editor
description: Run queries against Postgres, MySQL, Turso, Databricks, ClickHouse, and more.
sidebar_order: 4
---

Infrawrench ships an in-app SQL console so you do not need to juggle psql, mysql, and vendor consoles for quick lookups.

<insert [SQL editor with an autocomplete dropdown and a result table below] here>

## Where to open it

- **Per-database account** — click the **SQL** button on a Postgres, MySQL, Turso, ClickHouse, or Databricks account.
- **Per-resource** — many managed databases (RDS instances, PlanetScale branches, Neon branches, Cloud SQL, Turso databases) have their own SQL editor on the detail page so you do not have to add a separate account.

## Features

- **Autocomplete** from live schema introspection (tables, columns, functions).
- **Query history** per connection.
- **Result grid** with column sorting and cell-level copy.
- **Export** results as CSV or JSON.
- **Multi-statement** — run a single statement with Cmd/Ctrl + Enter, or run the whole buffer.

## Per-driver notes

- **Postgres** — full SQL, introspection from `information_schema`.
- **MySQL / PlanetScale** — PlanetScale uses Vitess, so cross-shard joins can fail; infrawrench surfaces the raw error.
- **Turso** — libsql dialect. Edge-replicated, so some writes lag on reads until replication catches up.
- **Databricks** — runs against a SQL warehouse; results are fetched via REST, not a long-lived connection.
- **ClickHouse** — HTTP interface. Large result sets stream into the grid.
- **MongoDB** — not SQL; uses a separate collection browser instead (see the [MongoDB plugin](../plugins/mongodb.md)).

## Writing vs reading

There is no read-only mode by default. If you want a query to dry-run, prepend your statement with `EXPLAIN` (Postgres, MySQL, ClickHouse) or whatever your engine supports.
