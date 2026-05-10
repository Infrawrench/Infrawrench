---
title: Turso
description: Manage Turso groups, databases, and auth tokens across edge locations.
sidebar_order: 14
---

## What you can manage

- Groups
- Databases within a group
- Auth tokens (per-database)
- 30+ edge locations for replica placement

## Credentials

Turso dashboard → **Settings → API Tokens → Create Token**. You also need to tell infrawrench which Turso organization to use.

- **API Token** — the token from the Turso dashboard.
- **Organization** — your Turso organization slug (shown in your dashboard URL).

<insert [Turso Add-account form with API token and organization fields] here>

## Notable flows

- **Database creation** with group and location pickers.
- **Auth token generation** — per-database; expose as an output for downstream plugins.
- **SQL editor** (libsql protocol) per database.

## Tips & limits

- libsql SQL is SQLite-compatible; some Postgres idioms will not work.
- Replicas are eventually consistent. A write committed to the primary can take a moment to appear on a far-away replica.
