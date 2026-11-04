---
title: Turso
description: Manage Turso groups, databases, instances, API tokens, members, invites, and locations, with usage, plan limits, and database protection settings.
sidebar_order: 14
---

## What you can manage

- Groups
- Databases within a group, including branches and point-in-time copies
- Database instances
- Platform API tokens across the organization, with their owner, scopes, and group
- Organization members and pending invites
- Locations for group placement (Turso Cloud's AWS locations, plus the older edge locations on groups that haven't moved yet)
- Auth tokens created per database when you export a connection string

## Connect your organization

In the Turso dashboard, go to **Settings > API Tokens > Create Token**. Then fill in:

- **API Token**: the token from the Turso dashboard.
- **Organization**: your Turso organization slug (shown in your dashboard URL).

![Turso Add-account form with API token and organization fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/turso/add-account.png)

## Things you can do

- **Create a database** with a group picker. Pick an existing database under **Copy From** to branch it instead of starting empty, and optionally a **Point in Time** to restore the copy as of that moment. How far back you can go depends on your Turso plan.
- **Change database settings**: **Edit** on a database sets delete protection, blocks reads or writes, caps its size, and limits connections to listed IP addresses/CIDR blocks or AWS VPC endpoints. Only the settings you change are updated, so an allow list is never cleared by accident. Empty the field yourself to remove it.
- **See usage and top queries**: the database page shows rows read and written, storage, and bytes synced for the current billing month, plus the queries that read and wrote the most rows. Dashboard cards show the same usage figures.
- **Chart usage**: databases have a Metrics tab charting rows read, rows written, storage and bytes synced per day (the last 7 days by default, up to 31 days).
- **Manage groups**: create a group in one of the locations Turso currently offers, optionally with the bundled SQLite extensions. **Edit** toggles delete protection. Groups also have **Update libSQL Version** and, when archived after inactivity, **Unarchive**.
- **Rotate Auth Tokens** on a database or group to cancel every token issued for it. Clients using an old token are disconnected until they get a new one.
- **Create auth tokens** per database, and offer them as an output to other plugins.
- **Review instances and locations** to check placement and replicas.
- **Review API tokens and members** for account hygiene. Admins see every token in the organization, members see their own. Deleting a token revokes it.
- **Invite people** by email with a role, and cancel pending invites.
- **SQL editor** (libsql protocol) per database.

## Plan limits

Your plan's allowances (rows read and written, storage, embedded-replica sync, databases, groups, locations) show against the current billing cycle's usage on [Quota radar](../features/quota-radar.md). Limits your plan doesn't have are left out.

## Tips & limits

- libsql SQL is SQLite-compatible, so some Postgres idioms won't work.
- Replicas are eventually consistent. A write committed to the primary can take a moment to appear on a far-away replica.
- Multi-region replicas and multi-database schemas are only available to existing paid organizations. Turso rejects them for new ones.

## Cost graphs

Turso organizations feed [cost graphs & budgets](../features/cloud-costs.md) from your invoices: monthly organization totals, shown on invoice dates. Turso doesn't break dollars down per database.

- Your existing platform API token is enough.
