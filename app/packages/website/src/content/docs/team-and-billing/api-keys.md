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

## Scoping and limits

- Keys are scoped to the issuing user’s role.
- You can limit a key to specific accounts at creation time.
- No per-endpoint scoping yet.

## Audit

Every API call is attributed to the key in the [audit log](./audit-log.md), including the key’s name.
