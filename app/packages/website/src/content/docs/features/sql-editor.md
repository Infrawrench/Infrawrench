---
title: SQL editor
description: Run queries against Postgres, MySQL, Turso, Databricks, Snowflake, ClickHouse, and more.
sidebar_order: 4
---

Run quick queries against your databases without leaving Infrawrench. No need to juggle psql, mysql and vendor consoles for a fast lookup.

![SQL editor with the schema browser expanded and a result table below](https://agent-assets.infrawrench.com/docs-screenshots/features/sql-editor/sql-editor-results.png)

## Open the editor

- **From a database account:** click **SQL** on a Postgres, MySQL, Turso, ClickHouse or Databricks account.
- **From a resource:** many managed databases (RDS instances, PlanetScale branches, Neon branches, Cloud SQL, Turso databases) have their own SQL editor on the detail page, so you don't need to add a separate account.

## What you can do

- **Browse the schema** in the left sidebar. Filter it with the **Search tables…** box and expand a table to see its columns and types. Click a table name to run `SELECT * FROM <table> LIMIT 100;`. Primary-key columns are marked with a ⚿.
- **Read results** in the grid. Primary-key columns are badged **PK** and nulls show as `NULL`.
- **Edit rows inline.** When your query selects from a single table and returns all of its primary-key columns, click the pencil on a row to edit the non-key cells. Saving writes an `UPDATE` back.
- **Export CSV** to download the current result set.
- **Estimate** the cost before you run, on engines that support a dry run (BigQuery, Databricks). The toolbar shows the bytes and cost, or "cache hit · free".
- **Run ⌘↵** runs the whole buffer. Tab inserts two spaces instead of moving focus.

The editor is a plain text area. There's no autocomplete, and query history isn't kept between visits.

## Notes by database

- **Postgres:** full SQL.
- **MySQL / PlanetScale:** PlanetScale uses Vitess, so cross-shard joins can fail. You'll see the raw error.
- **Turso:** libsql dialect. It's edge-replicated, so a read right after a write may not show the change until replication catches up.
- **Databricks:** queries run against a SQL warehouse.
- **Snowflake:** every Snowflake resource has a SQL tab. On a warehouse, queries run on that warehouse. On a database or schema, they run in that context and the sidebar lists its tables and columns. Results stop at 10,000 rows.
- **ClickHouse:** large result sets stream into the grid.
- **MongoDB:** not SQL. Use the collection browser instead (see the [MongoDB plugin](../plugins/mongodb.md)).

## Reads and writes

There's no read-only mode by default, so write queries will run. To check a query without running it, prefix it with `EXPLAIN` (Postgres, MySQL, ClickHouse) or your engine's equivalent.
