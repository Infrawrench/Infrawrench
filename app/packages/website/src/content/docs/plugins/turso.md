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
- Locations for group placement (Turso Cloud's AWS locations, plus the older edge locations on groups that have not migrated)
- Auth tokens generated per database when exporting a connection string

## Credentials

Turso dashboard → **Settings → API Tokens → Create Token**. You also need to tell infrawrench which Turso organization to use.

- **API Token** — the token from the Turso dashboard.
- **Organization** — your Turso organization slug (shown in your dashboard URL).

![Turso Add-account form with API token and organization fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/turso/add-account.png)

## Notable flows

- **Database creation** with a group picker. Pick an existing database under **Copy From** to branch it instead of starting empty, and optionally a **Point in Time** to restore the copy as of that moment. How far back you can go depends on your Turso plan.
- **Database settings**: **Edit** on a database sets delete protection, blocks reads or writes, caps its size, and restricts connections to listed IP addresses/CIDR blocks or AWS VPC endpoints. Only the settings you change are sent, so an allow-list is never cleared by accident; empty the field yourself to remove it.
- **Usage and top queries**: the database detail page shows rows read and written, storage, and bytes synced for the current billing month, plus the queries that read and wrote the most rows. Dashboard cards show the same usage figures.
- **Usage charts**: databases have a Metrics tab charting rows read, rows written, storage, and bytes synced per day (the last 7 days by default, up to 31 days). Turso's usage API only returns totals for a window, so the chart asks once per day.
- **Group management**: create a group in one of the locations Turso currently offers, optionally with the bundled SQLite extensions. **Edit** toggles delete protection. Groups also have **Update libSQL Version** and, when archived after inactivity, **Unarchive**.
- **Rotate Auth Tokens** on a database or group invalidates every token issued for it. Clients using an old token are disconnected until they get a new one.
- **Auth token generation** — per-database; expose as an output for downstream plugins.
- **Instance and location inventory** for placement and replica inspection.
- **API token and organization member inventory** for account hygiene. Admins see every token in the organization; members see their own. Deleting a token revokes it.
- **Invites**: invite someone by email with a role, and cancel pending invites.
- **SQL editor** (libsql protocol) per database.

## Plan limits

Turso organizations report their plan's allowances (rows read and written, storage, embedded-replica sync, databases, groups, locations) against the current billing cycle's usage on [Quota radar](../features/quota-radar.md). Dimensions your plan doesn't cap are left out.

## Tips & limits

- libsql SQL is SQLite-compatible; some Postgres idioms will not work.
- Replicas are eventually consistent. A write committed to the primary can take a moment to appear on a far-away replica.
- Multi-region replicas and multi-database schemas are only available to existing paid organizations; Turso rejects them for new ones.

## Cost graphs

Turso organizations feed [cost graphs & budgets](../features/cloud-costs.md) from issued invoices — monthly org-level totals (Turso's API does not expose per-database dollar breakdowns), shown on invoice dates.

- The existing platform API token is sufficient.
