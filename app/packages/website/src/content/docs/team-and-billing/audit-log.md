---
title: Audit log
description: See who did what across your organization.
sidebar_order: 4
---

> **Paid plan only.** Available on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

The audit log records every state-changing action in the organization — resource created, account added, SSH session opened, secret exported, member invited, role changed, API key issued. Read-only views (listing a sidebar, opening a dashboard) are not recorded.

![Audit log table with time, user, action and entity columns](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/audit-log/audit-log-table.png)

## What is captured

The table has four columns:

- **Time** — wall-clock in your timezone.
- **User** — who did it, or **API Key** when the call came in on an [API key](./api-keys.md) and **System** for automated work.
- **Action** — verb + object (e.g. “created Droplet”, “started SSH session”).
- **Entity** — the type and id of the resource or account affected.

Twenty-five entries to a page, newest first, with **Previous** / **Next** underneath and a count of everything matched.

## Filtering

The page has one filter: a **Filter by type** dropdown over the entity type — account, resource, dashboard, api_key, member, subscription — or **All types**.

The API is where the finer questions get asked. `GET /api/org/<orgId>/audit-logs` takes `action`, `entityType`, `userId`, `from` and `to`, and — most usefully — `apiKeyId`, which is everything one credential did and the first thing to pull when a token leaks. `userId` cannot answer that question on its own, because a person and every key they minted share one user id.

## Retention

Audit entries are kept for 1 year on the paid plan. Longer retention is available on request.

## What it does not capture

- Credential values (they are never logged, only references).
- The content of SQL queries, SSH sessions, or manifest edits — only that the session happened.

If you need deeper logging for a regulated environment, talk to us.
