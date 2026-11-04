---
title: Audit log
description: See who changed what across your Infrawrench organization, and filter by type or API key.
sidebar_order: 4
---

> **Paid plan only.** Available on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

The audit log shows every change made in your organization: a resource created, an account added, an SSH session opened, a secret exported, a member invited, a role changed, an API key created. Just looking at things (opening a sidebar or a dashboard) isn't recorded.

![Audit log table with time, user, action and entity columns](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/audit-log/audit-log-table.png)

## What you see

The table has four columns:

- **Time:** in your timezone.
- **User:** who did it. If it was done with an [API key](./api-keys.md), you see the key's name and `iwk_` prefix next to its owner, so you can tell a person from a token. Automated work shows as **System**.
- **Action:** what happened, for example "created Droplet" or "started SSH session".
- **Entity:** the type and id of the resource or account affected.

You get 25 entries per page, newest first, with **Previous** and **Next** buttons and a total count.

## Filter the log

There are two filters:

- **Filter by type** narrows to one entity type: account, resource, dashboard, api_key, member or subscription. **All types** shows everything.
- **Filter by API key** shows everything one key did. Clicking the key chip in the User column does the same. **All API keys** clears it. Deleted keys still work as a filter.

For finer questions, use the API. `GET /api/org/<orgId>/audit-logs` takes `apiKeyId`, `action`, `entityType`, `userId`, `from` and `to`. When a token leaks, filter by `apiKeyId` first. `userId` alone can't answer that, because a person and all their keys share one user id.

## How long entries are kept

Entries are kept for 1 year on the paid plan. Longer retention is available on request.

## What isn't recorded

- Credential values. Only references to them are logged.
- What happened inside SQL queries, SSH sessions or manifest edits. The log shows that the session happened, not its content.

If you need deeper logging for a regulated environment, talk to us.
