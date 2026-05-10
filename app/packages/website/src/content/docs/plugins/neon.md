---
title: Neon
description: Manage Neon projects, branches, and databases; get connection strings as outputs.
sidebar_order: 12
---

## What you can manage

- Projects
- Branches (create, delete, switch primary)
- Databases within a branch
- Connection strings (as outputs, referenceable from the [Postgres plugin](./postgres.md))

## Credentials

Neon console → **Account → API keys → New API key**.

<insert [Neon Add-account form with API key field] here>

## Notable flows

- **Branch creation** — point-and-click; infrawrench shows the parent branch and new branch name.
- **Password resolution** — infrawrench requests a fresh connection string for a branch when needed.
- **Secret export to K8s** — branches export their connection strings as K8s secrets.
- **SQL editor** per-branch (via the Postgres plugin’s output reference).

## Tips & limits

- Free tier Neon projects have branch limits — watch the UI for quota warnings.
- Branches take a few seconds to provision; the sidebar refreshes on the next tick.
