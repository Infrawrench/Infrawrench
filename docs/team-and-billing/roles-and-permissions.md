---
title: Roles and permissions
description: What owners and members can do.
sidebar_order: 2
---

> **Web only.**

Infrawrench has two roles.

| Action                           | Owner | Member |
| -------------------------------- | ----- | ------ |
| View resources                   | Yes   | Yes    |
| Create / edit / delete resources | Yes   | Yes    |
| Add accounts                     | Yes   | Yes    |
| Use SSH terminal / SQL editor    | Yes   | Yes    |
| Pin to dashboards                | Yes   | Yes    |
| Invite / remove members          | Yes   | No     |
| Change billing                   | Yes   | No     |
| Create / revoke API keys         | Yes   | Yes    |
| View audit log                   | Yes   | Yes    |
| Rename / delete organization     | Yes   | No     |

## Promoting a member

Owners can promote from **Settings → Team → (member) → Change role**. There must always be at least one owner.

## Why only two roles

We deliberately kept the model simple. If you need finer-grained permissions (per-account read-only, per-resource-type, etc.), tell us — it is on the roadmap if enough people ask.

## Audit trail

Every permission-sensitive action is recorded in the [audit log](./audit-log.md), including role changes.
