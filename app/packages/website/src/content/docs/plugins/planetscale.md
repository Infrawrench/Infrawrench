---
title: PlanetScale
description: Manage PlanetScale Vitess and Postgres databases, branches, deploy requests, backups, passwords, Postgres roles, and webhooks, with branch metrics.
sidebar_order: 13
---

## What you can manage

- Databases, both Vitess (MySQL-compatible) and Postgres
- Branches
- Branch passwords (Vitess)
- Postgres roles
- Deploy requests
- Branch backups
- Database webhooks
- Connection strings (generated per branch: a password on Vitess, a role on Postgres)

## Credentials

PlanetScale dashboard → **Settings → Service tokens → New service token**. Grant the roles needed for your databases, then paste:

- **Service Token ID** — the public ID (shown next to the token in the dashboard).
- **Service Token Secret** — the secret value (shown once at creation).
- **Organization** — your PlanetScale org slug.

![PlanetScale Add-account form with service token ID, secret, and organization fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/planetscale/add-account.png)

## Notable flows

- **Database creation**: pick the engine (Vitess or Postgres), a region that runs it, and a cluster size from the sizes your organization can provision.
- **Database settings**: **Edit** on a database sets deletion protection, deploy-request approval, the default branch, branch-region restriction, the production web console, full-query collection in Insights, and the development branch limit. On Vitess databases it also covers data branching, foreign key constraints, and migration-table copying. Only the settings you change are sent.
- **Branch creation**: from `main` or any branch, optionally seeded with data from the latest backup and with deletion protection on.
- **Branch actions**: **Promote to Production** / **Demote to Development**, and on Vitess production branches **Enable/Disable Safe Migrations**. **Edit** toggles deletion protection.
- **Branch metrics**: the Metrics tab charts queries, errors, rows read, written, and returned, p50/p95/p99 latency, connections, ingress and egress bytes, traffic-control throttles and warnings, CPU, memory, IOPS, container restarts and out-of-memory kills, storage, disk used, and replica lag from PlanetScale's Metrics API (the last 12 hours by default). Postgres branches add PgBouncer connections, WAL size, WAL archive lag, and WAL retained by replication slots; edge proxy throughput is charted where PlanetScale reports it.
- **Branch logs**: a branch's Logs tab shows the last day of Insights data, picked from two feeds: **query-errors** (each grouped error with its count and average duration) and **anomalies** (latency anomalies with the query most correlated with each).
- **Deploy requests**: list schema deploy requests with source and target branches, approval, and deployment state. Each one offers the next step its state allows: **Deploy**, **Apply Changes** for a gated cutover, **Cancel Deploy**, **Skip Revert Period**, **Revert**, or **Close**. Drag one branch onto another to open a deploy request.
- **Backups**: inspect branch backups, take an on-demand backup with its own retention, protect a backup from expiring, and delete it.
- **Passwords** (Vitess): create with a role, TTL, replica routing, and allowed CIDRs; rename or change CIDRs; **Renew** a password that has a TTL.
- **Postgres roles**: create a role with the built-in roles it inherits (read all data, write all data, monitor, and so on), an optional expiry, and query-safety rules that warn on or block `DELETE`/`UPDATE` without `WHERE`. Roles can be renewed, have their password reset, and be deleted.
- **Webhooks**: subscribe a URL to branch, deploy-request, backup, and storage events, with an optional `Authorization` header. **Send Test Event** checks delivery; the detail page shows whether the last delivery succeeded.
- **Connection string generation**: infrawrench creates a dedicated password (Vitess) or role (Postgres) for a branch and returns the resulting connection string as an output. The branch opens it in the [MySQL](./mysql.md) or [PostgreSQL](./postgres.md) tab to match its engine.
- **Secret export to K8s** — branches export credentials as secrets.
- **SQL editor** (via the MySQL or PostgreSQL plugin’s output reference).
- **Terraform export**: branches, passwords, and Postgres roles export as `planetscale_vitess_branch` / `planetscale_postgres_branch`, `planetscale_vitess_branch_password`, and `planetscale_postgres_branch_role`, with import IDs ready to adopt the live objects.

## Tips & limits

- PlanetScale uses Vitess. Cross-shard joins and some DDL shapes are restricted. Raw errors are passed through.
- Branch passwords and Postgres roles are listed without exposing plaintext. PlanetScale returns a secret only when it is created, so connection-string generation creates a dedicated password or role on demand. A role you create in infrawrench keeps its connection string as an output; after a **Reset Password**, create a new role to get one you can copy.
- Branch metrics need the service token's `read_branch` access. Without it the Metrics tab stays empty. The Logs tab reads Insights, which needs `read_database`.

## Cost graphs

PlanetScale organizations feed [cost graphs & budgets](../features/cloud-costs.md) from invoices and their line items — monthly billing periods with per-database and per-metric breakdowns (line items for the in-progress invoice refresh hourly).

- The service token needs the `read_invoices` organization access grant.
