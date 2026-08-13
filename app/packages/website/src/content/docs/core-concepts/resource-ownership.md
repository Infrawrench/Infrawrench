---
title: Resource ownership
description: Owner, purpose and ticket link as first-class fields on any resource — so the orphan finder names a person instead of a shrug, and alerts reach whoever actually cares.
sidebar_order: 6
---

Every infrastructure list eventually produces the same conversation. Something is running, it costs
money, nobody recognises it, and nobody will delete it in case it matters. The list is correct and
completely unactionable.

Ownership fixes the missing half. Any resource can carry three fields:

- **Owner** — a member of your organization. This is the one that makes alerts _routable_.
- **Purpose** — what it is for, in your own words.
- **Ticket** — a link to the issue, PR or ticket that authorized it.

Set them on a resource's **Ownership** tab, on the web and desktop apps.

![The Ownership tab on a resource detail view — the owner picker showing an org member selected, a free-text team field, a purpose textarea reading "Staging load tests for the checkout rewrite", and a ticket URL](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/resource-ownership/ownership-tab.png)

## Owner is a person, or a team, or both

The owner picker lists your organization's members. Picking one is what lets Infrawrench actually
_send_ something: alerts about that resource are delivered to them as well as to the org.

Not everything is owned by a person, so there is a second field for a free-text owner — "Platform
team", "the on-call rota", a contractor's name. It is shown everywhere the owner is shown, and it
is marked as a team so nobody mistakes it for someone who is being paged. Nothing can be routed to
a string.

If you set both, the member wins for display and for routing, and the team name is kept. That
matters when someone leaves: their user record goes, the owner falls back to the team name, and the
purpose and ticket you wrote survive.

You can also record a purpose and a ticket with **no** owner at all. That is genuinely useful —
"this exists because of ENG-482" answers most of the question — but the resource still counts as
unowned, because there is nobody to send the list to.

## The orphan finder stops shrugging

This is where ownership earns its place. The [orphan finder](../features/orphan-finder.md) already
tells you which resources look wasted. Now every flagged row carries its owner, and the ones with
nobody attached say so:

| Resource        | Reason                               | Owner                  |
| --------------- | ------------------------------------ | ---------------------- |
| `backups-old`   | Volume is not attached to any server | Sam Reyes              |
| `staging-lb-ip` | Floating IP is not assigned          | Platform team _(team)_ |
| `vol-8823a1`    | Volume is not attached to any server | _Unowned_              |

Under the list you get the count that actually drives work: **"12 of 34 have no recorded owner —
nobody to ask before deleting, and nobody an alert can reach."** That number is the backlog. Every
resource you attribute takes one off it.

`Unowned` is printed rather than left blank on purpose. A blank cell reads as "not looked up"; the
point is that this was looked up and the answer is nobody.

The same column appears in `infrawrench orphans` and on the mobile Costs tab.

## Alerts reach a person, not just a channel

When a resource has a routable owner, alerts about _that_ resource are delivered to them
personally, in addition to the usual org-wide fan-out:

- **[Lease](../features/resource-leases.md) countdowns** — "your test cluster is deleted in 24
  hours" is addressed to somebody in particular.
- **[Probe](../features/synthetic-probes.md) transitions** — when a probe linked to an owned
  resource goes down, its owner gets "Your endpoint is down", and the team-wide message names them
  so everyone else knows who is likely already on it.

The personal copy is always **in addition to** the org fan-out, never instead of it. An outage must
not become invisible to the team because one owner is on holiday. The owner's own notification
preferences still apply — ownership does not override an opt-out — and someone who has left the
organization is not reachable at all, even if a record still names them.

## Ownership outlives the resource

The record is stored beside the resource rather than on it, so re-syncing, a resource briefly
disappearing from the provider, or a rename does not lose it. Deleting the **account** takes its
ownership records with it.

Clearing every field removes the record entirely. That is deliberate: an empty record and no record
should not be two different states.

## Permissions

Reading ownership needs `resources:read`; setting it needs `resources:write`. It is deliberately
**not** an admin-only field — the person who can create a resource is the person who should be able
to say it is theirs, and requiring an admin to record ownership is how ownership data stops
existing.

The owner picker is also on `resources:read` rather than `team:read`, so recording an owner does not
require permission to see roles and membership.

Changes are recorded in the [audit log](../team-and-billing/audit-log.md).

## Elsewhere

- `infrawrench ownership` lists everything recorded, with `infrawrench ownership <query>` to filter
  by resource, owner or purpose. See the [CLI](../features/cli.md).
- The [MCP server](../features/mcp.md) exposes `list_resource_ownership`, so an AI assistant can
  answer "who owns this?" and "what has nobody claimed?" before proposing a deletion.
- The mobile app shows the owner against each flagged resource on the Costs tab; setting one is a
  web/desktop task.

## Related

- [Orphan finder](../features/orphan-finder.md) — the list ownership makes actionable
- [Resource leases](../features/resource-leases.md) — the other answer to "why is this still here?"
- [Roles and permissions](../team-and-billing/roles-and-permissions.md)
