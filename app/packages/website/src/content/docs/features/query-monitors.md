---
title: Query monitors
description: A read-only SQL query on a schedule, with a threshold and an alert — for the incidents that are visible in your data and in no metric.
sidebar_order: 13
---

[Metric alerts](./metric-alerts.md) watch what your provider reports: CPU,
connections, replication lag. That misses a whole class of incident, because
some problems are only visible in the data:

- the `orders` table stopped growing at 04:00;
- the dead-letter queue has four thousand rows in it;
- yesterday's ETL wrote nought rows and nobody noticed;
- a feature flag left 12,000 accounts in a state that should be empty.

Every one of those is one query. **Query monitors** run that query on a
schedule and alert when the answer crosses a line.

Open it from the sidebar.

<insert [The Query monitors workspace tab showing three monitors with OK / Breaching / Not known pills, each with its SQL below, and the editor open with a "Try it" result] here>

## Writing one

Pick what to run against, write the query, choose what to measure and when to
alert.

**Run against** lists everything a monitor's query can reach, grouped by
account: an account whose credentials are themselves a database connection
(a Postgres or MySQL account) shows up as _Entire account_, and a database
that is a **resource inside an account** shows up under its own name — a
ClickHouse service, a Cloudflare D1 or Turso database, a Databricks SQL
warehouse, a BigQuery dataset or Spanner database. Managed databases that
open a database tab on their detail page qualify the same way: a Neon
project, branch or database, a PlanetScale branch, an RDS instance or
cluster, Redshift, Cloud SQL, AlloyDB, an Azure SQL database or flexible
server, and DigitalOcean, OVH or Scaleway managed databases (SQL engines
only — a cluster running Valkey or MongoDB is not offered, and neither is an
instance without a reachable endpoint). Accounts with none of these are not
offered; a monitor pointed at one could only ever fail.

- **First value** compares the first column of the first row — the shape of
  `SELECT count(*) …`.
- **Row count** compares how many rows came back, which is what makes
  `SELECT id FROM orders WHERE stuck` a monitor without a `count()`.

**Try it** runs the query once without saving and shows what came back, so you
find out that the table is called `dead_letter` rather than `dead_letters`
before the monitor does.

## Only reads, and only one statement

A monitor may run `select`, `with`, `show` or `explain`, and exactly one
statement. That is an allowlist of leading keywords, not a denylist of
dangerous ones — a denylist has to be right about every dialect's spelling of
every destructive verb, forever, and only has to be wrong once.

Comments are stripped before the check, so `-- harmless` followed by a `DROP`
is refused. So is `SELECT 1; DROP TABLE users`, by the single-statement rule.

The guard runs **on every execution**, not only when you save. A monitor
executes unattended, on a schedule, with your account's credentials, forever —
which is a categorically different risk from the SQL editor, where a person
types a statement and watches it run.

Creating or editing a monitor needs **Resources: execute**, the same permission
the SQL editor needs, for the same reason.

## Three states, and the third one matters

- **OK** — the query ran and the answer is inside the threshold.
- **Breaching** — the query ran and the answer is not.
- **Not known** — the query did not run, or returned nothing comparable.

**Not known is not OK.** A monitor whose query fails has told you nothing about
your data. Rendering that as healthy is exactly how a broken monitor becomes
indistinguishable from a working one, which would defeat the feature. The error
message from the driver is shown as-is — "relation does not exist" is the most
useful thing this page can say.

Both of those states reach the [wallboard](./wallboard.md) too: a breaching
monitor is listed with what it saw against what it watches for, and one that
could not run is listed with the driver's message. A monitor that has not run
yet is on neither — it has not failed, it has not started.

## Not paging on a wobble

A query against a live table is a sample. A count that dips for one run while a
batch job is mid-write is not an incident, and a monitor that pages on it gets
muted within a week.

**Breach this many runs in a row** is the answer. The alert fires on the run
that _reaches_ the number and not on the runs after it, so a breach pages once
rather than every fifteen minutes until somebody fixes it. An OK run re-arms it.

A failed run does **not** reset the streak. Breach, error, breach is two
breaches — treating the error as a recovery would let an intermittently failing
query hold off an alert forever.

## Where the alert goes

Through your [alert routing rules](./alert-routing.md), like every other alert
— so a query monitor can reach a Slack channel, a phone, or whoever is on call,
without the monitor knowing any of that exists.

## Editing re-arms it

Changing the query, the measure, the operator or the threshold resets the
breach streak. The streak was accumulated against a different question, and
carrying it forward would fire an alert on the first run of a rule nobody has
tested yet.

## Limits

Runs are every 5 minutes at the fastest and every week at the slowest. Monitors
run **sequentially** in the background, a few at a time: each one opens a
connection to your database, and a batch fanned out in parallel would be a
connection spike against your own production.

## Over the API

`/api/org/{orgId}/query-monitors` for the monitors,
`/api/org/{orgId}/query-monitors/test` to run one without saving, and
`/api/org/{orgId}/query-monitors/targets` for what a monitor can run against.
To scope a monitor to a database that is a resource, pass the resource's `id`
from the targets response — the server fills `resourceTypeId` in from the
synced resource, so you may omit it. See the
[OpenAPI reference](../team-and-billing/openapi.md).
