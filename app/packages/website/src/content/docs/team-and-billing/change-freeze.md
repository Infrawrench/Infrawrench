---
title: Change freezes
description: Set org-wide freeze windows in Infrawrench that block destructive actions, with audited admin overrides.
sidebar_order: 8
---

A **change freeze** is an org-wide window when destructive actions are blocked. Use one before a holiday weekend, during a launch, or while you review an incident. A freeze applies everywhere: the web app, API keys, the SDKs, and MCP and AI chat tools.

## What a freeze blocks

While a freeze is on, these actions are refused with `423 Locked`:

- **Deleting resources.**
- **Destructive plugin actions,** such as deleting an index, purging a cache or deleting a fine-tuned model. Non-destructive actions like restart or snapshot still work.
- **Destroying secret versions.** Enabling and disabling them still works.
- **Deployment rollbacks,** including ones requested through the AI assistant.

Reading, creating resources and routine work carry on as normal. A freeze stops you breaking things, not working.

Every blocked attempt is recorded in the [audit log](./audit-log.md) as `change_freeze.block`, with the freeze and the attempted action.

## Declare a freeze

Go to **Settings > Change Freezes**. Anyone with `freezes:write` (Admin and Owner by default) can declare one:

- **Name** and an optional **reason**, shown to anyone who gets blocked.
- **Starts:** defaults to now. Pick a future time to schedule it.
- **Ends:** optional. Leave it empty and the freeze holds until someone ends it.

![Settings > Change Freezes page showing one freeze "In effect" with an amber badge, one "Ended", and the "Declare freeze" form open with name/reason/start/end fields](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/change-freeze/declare-form-and-list.png)

While a freeze is on, every member sees a banner across the top of the app with the freeze name, its end time and a link to the Change Freezes page.

![App shell with the amber change-freeze banner visible below the workspace tab strip and above the sidebar, reading "Change freeze: Holiday freeze. Destructive actions are blocked until Jan 2, 9:00 AM"](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/change-freeze/app-shell-banner.png)

To end a freeze early, click **End now** on the same page. It stops immediately and `change_freeze.end` is recorded in the audit log.

## Override a freeze

Sometimes the destructive action is the fix. If you have `freezes:override` (Admin and Owner by default), you can get past a freeze for a single request by adding this header to the blocked call:

```
x-change-freeze-override: true
```

The header only works for people with the permission. Every successful override is recorded in the audit log as `change_freeze.override`, naming the freeze and the action.

MCP and AI chat tools can't override a freeze. An agent that hits one is told to ask a person, who can end the freeze or do the action themselves.

## If you get blocked

A blocked call returns `423` with this body:

```json
{
  "error": "Change freeze \"Holiday freeze\" is in effect until 2026-01-02T09:00:00.000Z. Destructive actions are blocked. ...",
  "code": "change_freeze_active",
  "freeze": {
    "id": "…",
    "name": "Holiday freeze",
    "reason": "No production changes over the holidays.",
    "startsAt": "2025-12-24T00:00:00.000Z",
    "endsAt": "2026-01-02T09:00:00.000Z"
  }
}
```

In the web app you'll see a message naming the freeze and when it ends.

## Permissions

| Permission         | Grants                                        | Held by default  |
| ------------------ | --------------------------------------------- | ---------------- |
| `freezes:read`     | See freeze windows and the current status     | All system roles |
| `freezes:write`    | Declare, edit, end, and delete freeze windows | Admin, Owner     |
| `freezes:override` | Bypass an active freeze per-request           | Admin, Owner     |

You can add these to [custom roles](./roles-and-permissions.md) and use them as [API key](./api-keys.md) scopes.

## Freezes during incidents

[Incident mode](../features/incident-mode.md) can start a freeze when an incident is declared, and ends that same freeze when the incident is resolved. The person declaring the incident still needs `freezes:write`. If they don't have it, the freeze isn't created (the incident shows which permission was missing), but the incident still goes ahead.

## API

Manage freeze windows at `/api/org/{orgId}/change-freezes` (list, create, update, end, delete). `GET /api/org/{orgId}/change-freezes/status` returns the freeze currently in effect. See the [API reference](./openapi.md) for schemas.
