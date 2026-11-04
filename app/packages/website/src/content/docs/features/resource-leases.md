---
title: Resource leases
description: Put an expiry on any resource, like "a test cluster for 3 days", get reminders through the expiry radar as it approaches, and optionally have the resource deleted when the lease runs out.
sidebar_order: 12
---

Test clusters, demo droplets, load-test databases: the resources you spin up "just for a few days" are the ones still billing three months later. A **lease** puts an expiry date on any resource. Pick a deadline, optionally say why, and Infrawrench keeps the countdown for you. As the deadline approaches, the lease shows up in the [expiry radar](./expiry-radar.md) next to your certificates and domains, so the same alerts that warn you about a lapsing TLS certificate also remind you about the cluster you promised to tear down.

There are two kinds of lease:

- **Reminder only** (the default). The lease shows in the expiry radar and its alerts. Nothing is ever deleted.
- **Auto-delete.** You opt in per lease. When the lease expires, Infrawrench deletes the resource, the same as deleting it yourself. You're warned twice first, and [change freezes](../team-and-billing/change-freeze.md) pause deletion.

## Set a lease

1. Open the resource and go to its **Lease** tab (on web, and on desktop when signed in to Infrawrench Cloud).
2. Pick a preset (1 day, 3 days, 1 week, 30 days) or a custom date and time.
3. Add a note if you like ("Q3 launch load test, ask Dana").
4. Tick auto-delete if you want the resource deleted at the end.

Each resource can have one lease. Edit or cancel it from the same tab at any time. A lease can run at most 365 days.

![The Lease tab on a resource detail page showing the editor with the duration presets, the note field and the auto-delete checkbox with its warning copy](https://agent-assets.infrawrench.com/docs-screenshots/features/resource-leases/lease-editor.png)

An active lease shows how long is left, its note, which auto-delete warnings have gone out, and an **auto-delete** badge where it applies.

![The Lease tab showing an active auto-delete lease: "Expires in 3d", the note, the red auto-delete badge and "First auto-delete warning sent"](https://agent-assets.infrawrench.com/docs-screenshots/features/resource-leases/lease-active.png)

## Reminders

Active leases appear on the **Expiring** screen (web, desktop, mobile) in their own **Leases** group, sorted by urgency like everything else, with auto-delete leases clearly badged. They're included in the daily expiry alert to Slack, Microsoft Teams and mobile push, and in the weekly digest's "Expiring soon" line. Anything the [expiry radar](./expiry-radar.md) does, leases get too.

![The Expiring screen with a "Leases" group showing two leases, one carrying the red auto-delete badge](https://agent-assets.infrawrench.com/docs-screenshots/features/resource-leases/expiring-leases-group.png)

## How auto-delete works

An auto-delete lease is never a surprise. You get **two** warnings first:

1. **First warning**, about 72 hours before expiry: "auto-delete is approaching".
2. **Final warning**, about 24 hours before expiry: "will be auto-deleted in ~24h".

Shorter leases get warnings sooner (a 12-hour lease is warned about right away and again halfway through). **Both warnings always go out before anything is deleted**, even if that means the delete happens a little after the lease's expiry. Warnings go to the same channels as expiry alerts.

When the lease expires and both warnings have gone out:

- If a [change freeze](../team-and-billing/change-freeze.md) is in effect, the delete waits until the freeze lifts, and the lease shows that it was deferred. Nothing is deleted during a freeze.
- Otherwise the resource is deleted and you get a final notification ("Lease expired: _name_ was deleted").
- If the provider keeps refusing the delete, Infrawrench retries for about an hour, then marks the lease **failed** with the error and tells your organization.

Deletes made by a lease are recorded in the [audit log](../team-and-billing/audit-log.md).

## Permissions

- Viewing leases needs `resources:read`.
- Creating, editing and cancelling them needs `resources:write`.
- Turning **auto-delete on** also needs `resources:delete`, the same permission as deleting the resource directly.

## Use the CLI

`infrawrench leases` lists every lease in your organization with its deadline, auto-delete flag, status and note. Add `--output json` for scripts. Lease deadlines also appear in `infrawrench expiring` alongside everything else that's expiring.

```
$ infrawrench leases
Acme Corp · 3 leases (2 active)

resource            account     expires                     auto-delete  status              note
load-test-cluster   Prod DO     in 2d (2026-08-06 17:00Z)   yes          first warning sent  Q3 launch load test
demo-droplet        Prod DO     in 6d (2026-08-10 09:00Z)   no           active              sales demo
old-staging-db      Legacy AWS  2026-07-28 12:00Z           yes          deleted             -
```

## Limits

- Leases need Infrawrench Cloud. The desktop app shows the Lease tab when signed in, but not in local-only mode.
- On mobile you can see leases on the Expiring screen, but setting and editing them happens on web or desktop.
- If Infrawrench can't delete a particular resource type, you can still give it a reminder-only lease. An auto-delete lease on it would fail and tell you so.
