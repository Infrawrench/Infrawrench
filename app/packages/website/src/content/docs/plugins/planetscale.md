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
- Connection strings (made per branch: a password on Vitess, a role on Postgres)

## Connect with PlanetScale

Click **Connect with PlanetScale** on the add-account form to sign in instead of creating a service token. PlanetScale's consent screen lists the access Infrawrench asks for and the organizations (or individual databases) to grant it on. You can deny anything you don't want.

Infrawrench asks to read your user and organizations, invoices, databases, branches, deploy requests and backups, and to create, change and delete databases, branches, passwords, roles, backups, webhooks and deploy requests. Write access is only used for actions you take. Anything you deny shows up as a missing permission.

Once you approve, the **Organization** is filled in for you (the first one you granted, if you picked several; change it if needed) and the account is named after it. **Service Token ID** stays empty for a connected account.

The connection renews itself. If you revoke Infrawrench in your PlanetScale account settings, the account shows **Reconnect required**. Click **Reconnect** in its credentials to sign in again.

PlanetScale doesn't let connected accounts change a branch's safe migrations. **Enable/Disable Safe Migrations** needs a service token.

Connect with PlanetScale works in the web app and in the desktop app's cloud mode. Accounts stored locally on the desktop use a service token.

<insert [PlanetScale add-account form showing the Connect with PlanetScale button above the service token fields] here>

## Use a service token instead

In the PlanetScale dashboard, go to **Settings > Service tokens > New service token**. Grant the roles your databases need, then paste:

- **Service Token ID**: the public ID, shown next to the token in the dashboard.
- **Service Token Secret**: the secret, shown once when you create it.
- **Organization**: your PlanetScale org slug.

![PlanetScale Add-account form with service token ID, secret, and organization fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/planetscale/add-account.png)

## Things you can do

- **Create a database**: pick the engine (Vitess or Postgres), a region that runs it, and a cluster size your organization can provision.
- **Change database settings**: **Edit** on a database sets deletion protection, deploy-request approval, the default branch, branch-region restriction, the production web console, full-query collection in Insights, and the development branch limit. On Vitess it also covers data branching, foreign key constraints and migration-table copying. Only the settings you change are updated.
- **Create a branch**: from `main` or any branch, optionally seeded with data from the latest backup and with deletion protection on.
- **Branch actions**: **Promote to Production** or **Demote to Development**, and on Vitess production branches **Enable/Disable Safe Migrations**. **Edit** toggles deletion protection.
- **Branch metrics**: the Metrics tab charts queries, errors, rows read, written and returned, p50, p95 and p99 latency, connections, ingress and egress bytes, traffic-control throttles and warnings, CPU, memory, IOPS, container restarts and out-of-memory kills, storage, disk used, and replica lag (the last 12 hours by default). Postgres branches add PgBouncer connections, WAL size, WAL archive lag and WAL retained by replication slots. Edge proxy throughput is charted where PlanetScale reports it.
- **Branch logs**: a branch's Logs tab shows the last day of Insights data from two feeds: **query-errors** (each grouped error with its count and average duration) and **anomalies** (latency anomalies with the query most linked to each).
- **Deploy requests**: list schema deploy requests with source and target branches, approval and deployment state. Each one offers the next step its state allows: **Deploy**, **Apply Changes** for a gated cutover, **Cancel Deploy**, **Skip Revert Period**, **Revert** or **Close**. Drag one branch onto another to open a deploy request.
- **Backups**: inspect branch backups, take an on-demand backup with its own retention, protect a backup from expiring, and delete it.
- **Passwords** (Vitess): create with a role, TTL, replica routing and allowed CIDRs. Rename or change CIDRs, and **Renew** a password that has a TTL.
- **Postgres roles**: create a role with the built-in roles it inherits (read all data, write all data, monitor, and so on), an optional expiry, and query-safety rules that warn on or block `DELETE` and `UPDATE` without `WHERE`. You can renew a role, reset its password, or delete it.
- **Webhooks**: subscribe a URL to branch, deploy-request, backup and storage events, with an optional `Authorization` header. **Send Test Event** checks delivery, and the detail page shows whether the last delivery worked.
- **Get a connection string**: Infrawrench creates a dedicated password (Vitess) or role (Postgres) for a branch and gives you the connection string as an output. The branch opens it in the [MySQL](./mysql.md) or [PostgreSQL](./postgres.md) tab to match its engine.
- **Export secrets to Kubernetes**: branches export credentials as secrets.
- **SQL editor**, through the MySQL or PostgreSQL tab.
- **Terraform export**: branches, passwords and Postgres roles export as `planetscale_vitess_branch` / `planetscale_postgres_branch`, `planetscale_vitess_branch_password` and `planetscale_postgres_branch_role`, with import IDs ready to adopt the live objects.

## Tips & limits

- PlanetScale uses Vitess, so cross-shard joins and some DDL shapes are restricted. PlanetScale's errors are shown as is.
- Branch passwords and Postgres roles are listed without their plaintext. PlanetScale only shows a secret when it's created, so getting a connection string creates a new password or role. A role you create in Infrawrench keeps its connection string as an output. After a **Reset Password**, create a new role to get one you can copy.
- Branch metrics need the service token's `read_branch` access, or the Metrics tab stays empty. The Logs tab needs `read_database`.

## Cost graphs

PlanetScale organizations feed [cost graphs & budgets](../features/cloud-costs.md) from your invoices: monthly billing periods broken down by database and metric. The current invoice updates hourly.

- The service token needs the `read_invoices` organization access grant.
