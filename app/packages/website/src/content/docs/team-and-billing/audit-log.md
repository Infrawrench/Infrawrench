---
title: Audit log
description: See who did what across your organization.
sidebar_order: 4
---

> **Paid plan only.** Available on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

The audit log records every state-changing action in the organization — resource created, account added, SSH session opened, secret exported, member invited, role changed, API key issued. Read-only views (listing a sidebar, opening a dashboard) are not recorded.

![Audit log table with time, user, action and entity columns](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/audit-log/audit-log-table.png)

## What is captured

For each entry:

- **Action** — verb + object (e.g. “created Droplet”, “started SSH session”).
- **Actor** — the user that did it, and — when the call came in on an [API key](./api-keys.md) — which key. Both, not one or the other: a key acts as its owner, so the owner alone cannot tell you whether a person or a token was at the other end.
- **Target** — the resource or account affected, with a link.
- **Time** — wall-clock in your timezone; hover for UTC.
- **Source** — web UI, API, or automated (sync, refresh).

## Filtering

In the app, filter by target type or by a single **API key**. The key dropdown lists the organization's keys, and clicking the key chip in an entry's actor column narrows the log to that one credential without leaving the page — pick **All API keys** to go back. A key that has since been deleted still filters: the chip carries its id even when there is no key row left to name.

`GET /api/org/<orgId>/audit-logs` takes the same `apiKeyId`, plus `action`, `userId`, `entityType`, `from` and `to`. Everything one credential did is the first thing to pull when a token leaks, and `userId` cannot answer that question on its own, because a person and every key they minted share one user id.

## Export

**Export → CSV** or **JSON**. Exports respect active filters.

## Retention

Audit entries are kept for 1 year on the paid plan. Longer retention is available on request.

## What it does not capture

- Credential values (they are never logged, only references).
- The content of SQL queries, SSH sessions, or manifest edits — only that the session happened.

If you need deeper logging for a regulated environment, talk to us.
