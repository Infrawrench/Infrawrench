---
title: PlanetScale
description: Manage PlanetScale databases and branches with connection strings exposed as outputs.
sidebar_order: 13
---

## What you can manage

- Databases
- Branches
- Connection strings (generated per-branch via password creation)

## Credentials

PlanetScale dashboard → **Settings → Service tokens → New service token**. Grant the roles needed for your databases, then paste:

- **Service Token ID** — the public ID (shown next to the token in the dashboard).
- **Service Token Secret** — the secret value (shown once at creation).
- **Organization** — your PlanetScale org slug.

<insert [PlanetScale Add-account form with service token ID, secret, and organization fields] here>

## Notable flows

- **Branch creation** — from `main` or any branch, pick a name and click.
- **Connection string generation** — infrawrench creates a named password for a branch and returns the resulting connection string as an output. Reference it from the [MySQL plugin](./mysql.md) for SQL editor access.
- **Secret export to K8s** — branches export credentials as secrets.
- **SQL editor** (via the MySQL plugin’s output reference).

## Tips & limits

- PlanetScale uses Vitess. Cross-shard joins and some DDL shapes are restricted. Raw errors are passed through.
- Branch passwords are created on demand. If you have many secrets for one branch, there will be many passwords — delete stale ones in the PlanetScale UI to avoid clutter.
