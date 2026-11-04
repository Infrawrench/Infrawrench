---
title: Query monitors
description: Run a read-only SQL query on a schedule, with a threshold and an alert, to catch incidents that show up in your data and in no metric.
sidebar_order: 13
---

[Metric alerts](./metric-alerts.md) watch what your provider reports: CPU, connections, replication lag. Some problems only show up in your data:

- the `orders` table stopped growing at 04:00;
- the dead-letter queue has four thousand rows in it;
- yesterday's ETL wrote zero rows and nobody noticed;
- a feature flag left 12,000 accounts in a state that should be empty.

Each of those is one query. **Query monitors** run that query on a schedule and alert you when the answer crosses a line.

Open it from the sidebar.

<insert [The Query monitors workspace tab showing three monitors with OK / Breaching / Not known pills, each with its SQL below, and the editor open with a "Try it" result] here>

## Create a monitor

1. Pick what to run against.
2. Write the query.
3. Choose what to measure and when to alert.

**Run against** lists everything a monitor can query, grouped by account:

- An account that is itself a database connection (a Postgres or MySQL account) appears as _Entire account_.
- A database that's a **resource inside an account** appears under its own name: a ClickHouse service, a Cloudflare D1 or Turso database, a Databricks SQL warehouse, a BigQuery dataset or Spanner database.
- Managed databases that open a database tab on their detail page also qualify: a Neon project, branch or database, a PlanetScale branch, an RDS instance or cluster, Redshift, Cloud SQL, AlloyDB, an Azure SQL database or flexible server, and DigitalOcean, OVH or Scaleway managed databases. Only SQL engines are offered, so a cluster running Valkey or MongoDB won't appear, and neither will an instance without a reachable endpoint.

Accounts with none of these aren't listed.

Choose what to measure:

- **First value** compares the first column of the first row. Use it for `SELECT count(*) …`.
- **Row count** compares how many rows came back, so `SELECT id FROM orders WHERE stuck` works without a `count()`.

**Try it** runs the query once without saving and shows the result. That's how you find out the table is called `dead_letter`, not `dead_letters`, before the monitor does.

## Read-only, one statement

A monitor can only run `select`, `with`, `show` or `explain`, and only one statement. Comments are ignored when checking, so `-- harmless` followed by a `DROP` is refused. So is `SELECT 1; DROP TABLE users`. This check happens every time the monitor runs, not just when you save.

Creating or editing a monitor needs **Resources: execute**, the same permission as the SQL editor.

## The three states

- **OK:** the query ran and the answer is inside the threshold.
- **Breaching:** the query ran and the answer is outside it.
- **Not known:** the query didn't run, or returned nothing to compare.

**Not known doesn't mean OK.** A failing query tells you nothing about your data. The database's error message is shown as-is, and "relation does not exist" is usually exactly what you need to know.

Breaching and failing monitors also show on the [wallboard](./wallboard.md). A breaching monitor shows what it saw and what it's watching for. One that couldn't run shows the error. A monitor that hasn't run yet shows on neither.

## Avoid alerts on a one-off blip

A count that dips for one run while a batch job is halfway through writing isn't an incident.

Set **Breach this many runs in a row** to require several breaches before alerting. The alert fires once, on the run that reaches that number, not on every run after. An OK run resets it.

A failed run does **not** reset the count. Breach, error, breach counts as two breaches.

## Where alerts go

Alerts follow your [alert routing rules](./alert-routing.md), like every other alert, so a query monitor can reach a Slack channel, a phone or whoever's on call.

## Editing resets the count

Changing the query, the measure, the operator or the threshold resets the breach count, so a newly edited rule doesn't fire on its first run.

## Limits

Monitors run every 5 minutes at the fastest and once a week at the slowest. They run a few at a time rather than all at once, so they won't flood your database with connections.

## Use the API

- `/api/org/{orgId}/query-monitors` for the monitors
- `/api/org/{orgId}/query-monitors/test` to run one without saving
- `/api/org/{orgId}/query-monitors/targets` for what a monitor can run against

To point a monitor at a database that's a resource, pass the resource's `id` from the targets response. You can leave out `resourceTypeId`, it's filled in for you. See the [OpenAPI reference](../team-and-billing/openapi.md).
