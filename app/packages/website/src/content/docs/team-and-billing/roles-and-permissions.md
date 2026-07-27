---
title: Roles and permissions
description: System roles, custom roles, and the permission model.
sidebar_order: 2
---

> **Web only.**

Infrawrench uses a permission-based authorization model. Every API call and UI action is gated by one or more **permission strings**. Roles bundle permissions together, and members are assigned a role.

## Permission strings

Permissions are colon-separated identifiers. Granted permissions can use `*` as a wildcard at any segment, or a bare `*` to grant everything.

```
accounts:read              # list and view cloud accounts
resources:execute          # SSH, SQL, KV console, exec
resources:postgres:execute # narrow execute to a specific plugin
resources:*:read           # read any resource type
*                          # full access
```

The `Settings → Roles` page lists the full catalogue grouped by category (Accounts, Resources, Team, Billing, etc.). The same permission strings are accepted as **API key scopes** — a key with `resources:read` can hit every read-only resource endpoint.

<insert [Settings → Roles page showing the three system roles plus one custom role] here>

## System roles

Every organization has three pre-seeded system roles. They cannot be edited or deleted.

| Role   | Permissions                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | `*` — everything, including billing and deleting the organization.                                                                                                                                                                                                    |
| Admin  | Everything except `billing:write` and `org:settings:write`.                                                                                                                                                                                                           |
| Member | Read everything; connect to resources (SSH/SQL/exec); use [AI chat](../features/ai-chat.md) (`chat:read`, `chat:write`); manage own dashboards; view cost graphs and budgets (`costs:read`, `budgets:read` — creating budgets needs `budgets:write`, held by Admin+). |

System role permissions are computed in code, so upgrades extend them automatically when new permissions are added.

Two permissions are deliberately not in any system role, because they let unattended code write into the org:

- `costs:write` — [push cost rows](../features/server-push.md#cost-rows) from your own systems.
- `pages:write` — [raise an on-call page](../features/server-push.md#paging) from your own systems.

Grant them with a scoped [API key](./api-keys.md), or add them to a custom role. Admin and Owner hold them through their wildcards.

## Custom roles

Owners and anyone with `team:role:write` can define their own roles in **Settings → Roles → New role**. Pick permissions from the categorised list, or paste wildcard patterns (e.g. `resources:postgres:*`) into the advanced field.

<insert [Custom-role edit form with permissions grouped by category, wildcard input visible] here>

A custom role cannot be deleted while any member or pending invitation still references it. Reassign or revoke first.

## Assigning a role

Use **Settings → Team → (member) → Role picker** to change a member's role. The owner role cannot be reassigned through this picker — use the existing owner to promote someone first.

<insert [Team page member row with the new role picker dropdown open] here>

## API key scopes

API keys store the same permission strings as roles. When you create a key, pick the exact scopes it should carry; the server enforces them with the same matcher used for session permissions, including wildcards. Older keys created with the deprecated `sync:read`/`sync:write` scopes are migrated automatically the next time they authenticate.

A key never carries more authority than its owner. Its effective permissions are the **intersection** of its scopes and the current role of the user who created it, recomputed on every call — so demoting someone narrows their keys immediately, and a broadly-scoped key cannot outrun a role change.

Removing someone from the organization revokes the keys they created in it, and any key whose owner is no longer a member stops authenticating.

## Where permissions are enforced

The same permission set gates every surface, not just the web UI:

- **HTTP API** — checked per route (see `x-required-permission` in the [API reference](./openapi.md)).
- **[AI chat](../features/ai-chat.md) and [MCP](../features/mcp.md)** — reaching chat at all needs `chat:read` / `chat:write`, and each tool then declares the permission it needs, checked before the tool runs. A member who cannot delete a resource over HTTP cannot delete one by asking the assistant either, and destructive tools are re-checked at approval time rather than only when queued.
- **WebSocket sessions** (SSH terminals, SQL console, Kubernetes exec and port-forward) — require `resources:execute`, whether the connection authenticates with a browser session or an API key.

## Audit trail

Every permission-sensitive action is recorded in the [audit log](./audit-log.md), including role creates/edits/deletes and member-role changes.
