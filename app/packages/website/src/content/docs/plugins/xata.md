---
title: Xata
description: Manage Xata Postgres organizations, projects and copy-on-write branches, with backups, Postgres settings, SQL, metrics, logs, invoices, API keys and members.
sidebar_order: 50
---

Connect a Xata account to manage its Postgres projects and branches. This is the current Xata, a Postgres platform with copy-on-write branching and scale-to-zero; the older Xata workspace and database API no longer exists.

## What you can manage

- **Organizations**: billing status, usage tier, members and the running total of the upcoming invoice. Rename them.
- **Projects**: create, rename and delete; set scale-to-zero for base and child branches (on/off and idle minutes) and IP filtering (on/off and the allowed IPs or CIDR blocks).
- **Branches**: status, region, instance type, Postgres image, replicas, storage, instances, scale-to-zero and backup retention. Create a branch as an empty database (region, instance type with vCPUs, memory and monthly price, Postgres version, replicas, storage), as a copy-on-write copy of another branch, or from another branch's latest backup. Edit the name, description, replicas, storage, scale-to-zero and backup retention. Actions: **Hibernate** and **Wake** (also available on a sleep schedule), **Rotate credentials**, **Change instance type** and **Change Postgres image**. A **Postgres Settings** tab edits every configuration parameter Xata exposes, grouped by section with their defaults.
- **Backups**: each branch's continuous backup with its earliest and latest restore points.
- **API keys**: create organization keys with scopes and an optional project restriction and expiry (the token is shown once), see when each was last used, and delete them.
- **Members** (change between Admin and Editor, remove) and **invitations** (invite, resend, cancel).

<insert [Xata branch detail page showing status, instance type and the Hibernate, Rotate credentials and Change instance type actions] here>

## Credentials

Create an **organization API key** in the Xata console (`console.xata.io`, **API Keys**), or a user key with `xata keys user create`. Keys start with `xau_`. An organization key acts as an Admin limited by its scopes; a user key acts with your role. Give it:

- `org:read`, `project:read` and `project:write`, `branch:read` and `branch:write` to manage projects and branches,
- `credentials:read` and `credentials:write` for connection strings, the SQL editor and credential rotation,
- `metrics:read` and `logs:read` for the Metrics and Logs tabs,
- `keys:read`/`keys:write` and `role:read`/`role:write` to manage API keys and members.

<insert [Xata Add-account form with the API Key field filled in and the permission checklist below it] here>

## SQL and connections

Each branch has a **Connection String** output (with `sslmode=require` added), a **PostgreSQL** tab and a **SQL** tab. The SQL tab goes through Xata's HTTP SQL gateway on the branch's own host, so it works without a direct Postgres connection. Rotating credentials changes the password every consumer uses.

## Metrics and logs

The Metrics tab charts CPU, memory, disk, active and idle connections, network ingress and egress, read and write IOPS, latency and throughput, and replication lag at one-minute resolution (Xata keeps 30 days). With replicas, each instance gets its own series. The Logs tab shows the last day of Postgres logs, with a **warnings and errors** filter.

## Costs

Xata's invoices are collected monthly, each dated to the month it covers, and the upcoming invoice keeps the current month up to date. Invoices have a single total, so costs are not split by project or branch.

## Quotas

The quota radar tracks projects, active branches, branches per project, members and pending invitations against the limits Xata reports for your organization.

## Status

Incidents from `www.xatastatus.com` are matched to branches by region; console and API incidents apply to everything.

## Limits and quirks

- There is no official Terraform provider for the current Xata, so there is no Terraform export.
- Restoring from a backup creates a new branch from the latest restore point; Xata's API does not take a point-in-time timestamp.
- SSO configuration and GitHub repository mappings are left to the Xata console.
