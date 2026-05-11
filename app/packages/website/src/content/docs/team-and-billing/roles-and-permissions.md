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

| Role   | Permissions                                                                  |
| ------ | ---------------------------------------------------------------------------- |
| Owner  | `*` — everything, including billing and deleting the organization.           |
| Admin  | Everything except `billing:write` and `org:settings:write`.                  |
| Member | Read everything; connect to resources (SSH/SQL/exec); manage own dashboards. |

System role permissions are computed in code, so upgrades extend them automatically when new permissions are added.

## Custom roles

Owners and anyone with `team:role:write` can define their own roles in **Settings → Roles → New role**. Pick permissions from the categorised list, or paste wildcard patterns (e.g. `resources:postgres:*`) into the advanced field.

<insert [Custom-role edit form with permissions grouped by category, wildcard input visible] here>

A custom role cannot be deleted while any member or pending invitation still references it. Reassign or revoke first.

## Assigning a role

Use **Settings → Team → (member) → Role picker** to change a member's role. The owner role cannot be reassigned through this picker — use the existing owner to promote someone first.

<insert [Team page member row with the new role picker dropdown open] here>

## API key scopes

API keys store the same permission strings as roles. When you create a key, pick the exact scopes it should carry; the server enforces them with the same matcher used for session permissions, including wildcards. Older keys created with the deprecated `sync:read`/`sync:write` scopes are migrated automatically the next time they authenticate.

## Audit trail

Every permission-sensitive action is recorded in the [audit log](./audit-log.md), including role creates/edits/deletes and member-role changes.
