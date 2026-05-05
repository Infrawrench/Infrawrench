---
title: Audit log
description: See who did what across your organization.
sidebar_order: 4
---

> **Web only. Paid plan only.**

The audit log records every state-changing action in the organization — resource created, account added, SSH session opened, secret exported, member invited, role changed, API key issued. Read-only views (listing a sidebar, opening a dashboard) are not recorded.

<insert [Audit log table with action, actor, target, time columns] here>

## What is captured

For each entry:

- **Action** — verb + object (e.g. “created Droplet”, “started SSH session”).
- **Actor** — the user (or API key) that did it.
- **Target** — the resource or account affected, with a link.
- **Time** — wall-clock in your timezone; hover for UTC.
- **Source** — web UI, API, or automated (sync, refresh).

## Filtering

Filter by actor, action type, target type, time range, or text. Combine filters.

## Export

**Export → CSV** or **JSON**. Exports respect active filters.

## Retention

Audit entries are kept for 1 year on the paid plan. Longer retention is available on request.

## What it does not capture

- Credential values (they are never logged, only references).
- The content of SQL queries, SSH sessions, or manifest edits — only that the session happened.

If you need deeper logging for a regulated environment, talk to us.
