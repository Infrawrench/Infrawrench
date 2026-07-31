---
title: API keys
description: Issue tokens for programmatic access to your infrawrench organization.
sidebar_order: 5
---

> **Web only. Paid plan only.**

API keys let scripts and CI jobs list resources, create them, and read outputs programmatically. They act on behalf of the user who issued them, subject to that user’s role.

## Issue a key

1. **Settings → API keys → New key**.
2. Give it a name (e.g. `ci-deploy`).
3. Optionally scope it to one or more accounts.
4. Click **Create**.

The token is shown once. Copy it now; you cannot see it again.

<insert [API key create dialog with copy-once warning] here>

## Using a key

Send it as a bearer token:

```
Authorization: Bearer ik_live_...
```

See the [API reference](./openapi.md) for endpoints. Everything the UI does, the API does.

## Revoke

**Settings → API keys → (key) → Revoke**. The key stops working immediately. In-flight requests finish; new requests get 401.

## Rotate

There is no built-in rotate. Issue a new key, update your scripts, then revoke the old one.

## Scopes

API keys carry an explicit list of **permission strings** (scopes). The same vocabulary used for [roles](./roles-and-permissions.md) is used for API keys, so `resources:read` on a key gates the same endpoints as `resources:read` on a role.

When you create a key you pick its scopes. Pick the narrowest set that gets the job done — a CI deploy key might only need `accounts:read` + `resources:read`, while a sync agent for the desktop app needs `resources:read` + `resources:write`.

A sync-scoped key cannot read provider credentials. The sync endpoints report only whether an account has credentials stored; fetching one is a separate, audit-logged call that requires `secrets:read`.

Wildcard scopes are honored: `resources:*:read`, `resources:postgres:*`, or just `*` for full access. The exact catalogue is documented in the [API reference](./openapi.md) under each operation's `x-required-permission` extension. The OpenAPI spec also exposes a `Permission` enum listing every recognised string.

The `chat:read` and `chat:write` scopes gate the [AI chat](../features/ai-chat.md) API: list/inspect conversations vs. send messages and approve destructive tool calls. Calls authed by a `chat:write` key still meter tokens to the org and respect the org-level monthly spend cap.

The `costs:write` and `pages:write` scopes gate the [push endpoints](../features/server-push.md): reporting your own cost rows, and raising an on-call page from a server. Neither is in a system role, so a key carrying one must be held by an Admin or Owner, or by a member whose custom role grants it — the intersection rule below still applies.

`chat:write` lets a key hold a conversation — it does not widen what that conversation can do. Every tool the assistant runs is checked against the key's own scopes, so a chat-only key can talk about your infrastructure but cannot read a secret or delete a resource unless you also granted `secrets:read` or `resources:delete`.

Older keys created with the deprecated `sync:read` / `sync:write` scopes are renamed automatically the next time they authenticate. The workflow permission split was handled differently, once: [workflows](../features/workflows.md) were gated on `dashboards:read` / `dashboards:write` until they got their own `workflows:read`, `workflows:write` and `workflows:approve` scopes, so every key that was still active at that upgrade had the matching workflow scopes added to it there and then — they are listed on the key like any other scope, and nothing is added at authentication time. Revoked keys were left alone. Every key created since carries exactly the scopes you chose, so grant the workflow scopes a key actually needs — `workflows:read` to list and inspect, `workflows:write` to edit and run, `workflows:approve` to decide an approval step. Use `workflows:*` only for a key that should hold the whole family.

## Keys are bounded by their owner

A key's effective permissions are its scopes **intersected with** the current role of the user who created it, evaluated on every request. Two consequences worth planning around:

- Demoting a teammate immediately narrows every key they issued. A key scoped `*` held by someone moved from Admin to Member can now only do what a Member can.
- Removing someone from the organization revokes the keys they created there. Any key whose owner is no longer a member stops authenticating, even if it was never explicitly revoked.

For automation that must survive staff changes, create the key under an account that stays in the org — not a personal one belonging to someone who may leave.

## Audit

Every API call is attributed to the key in the [audit log](./audit-log.md), including the key’s name.
