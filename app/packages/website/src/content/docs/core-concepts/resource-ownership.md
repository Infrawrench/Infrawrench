---
title: Resource ownership
description: Record an owner, purpose and ticket link on any resource, so the orphan finder names a person and alerts reach whoever is responsible.
sidebar_order: 6
---

You've seen it before. Something is running, it costs money, nobody recognises it, and nobody wants to delete it in case it matters. Ownership fixes that by letting you record who a resource belongs to and why it exists.

Any resource can carry three fields:

- **Owner**: a member of your organization. This is what lets alerts reach a person.
- **Purpose**: what it's for, in your own words.
- **Ticket**: a link to the issue, PR or ticket that approved it.

## Set an owner

Open a resource and go to its **Ownership** tab (web and desktop apps). Pick an owner, add a purpose and paste a ticket link.

![The Ownership tab on a resource detail view, with the owner picker showing an org member selected, a free-text team field, a purpose textarea reading "Staging load tests for the checkout rewrite", and a ticket URL](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/resource-ownership/ownership-tab.png)

### A person, a team, or both

The owner picker lists your organization's members. Pick one and alerts about that resource go to them as well as to the org.

Not everything belongs to one person, so there's also a free-text team field: "Platform team", "the on-call rota", a contractor's name. It shows wherever the owner shows, marked as a team so nobody thinks it's someone being paged. Alerts can't be sent to a team name.

If you set both, the member is shown and gets alerts, and the team name is kept. If that person leaves, the owner falls back to the team name, and the purpose and ticket stay.

You can also record a purpose and ticket with **no** owner. "This exists because of ENG-482" answers most of the question. The resource still counts as unowned, though, because there's nobody to alert.

## See who owns flagged resources

The [orphan finder](../features/orphan-finder.md) shows which resources look wasted. Each flagged row now shows its owner, and the ones with nobody say so:

| Resource        | Reason                               | Owner                  |
| --------------- | ------------------------------------ | ---------------------- |
| `backups-old`   | Volume is not attached to any server | Sam Reyes              |
| `staging-lb-ip` | Floating IP is not assigned          | Platform team _(team)_ |
| `vol-8823a1`    | Volume is not attached to any server | _Unowned_              |

Under the list you get the count that matters: **"12 of 34 have no recorded owner. Nobody to ask before deleting, and nobody an alert can reach."** That's your backlog. Every resource you assign takes one off it.

`Unowned` means someone checked and the answer is nobody, not that it wasn't looked up.

The same column appears in `infrawrench orphans` and on the Savings tab of the mobile Costs screen.

## Alerts that reach the owner

When a resource has an owner who is a member, alerts about that resource go to them personally, as well as to the usual org channels:

- **[Lease](../features/resource-leases.md) countdowns**: "your test cluster is deleted in 24 hours" goes to someone in particular.
- **[Probe](../features/synthetic-probes.md) changes**: when a probe linked to an owned resource goes down, the owner gets "Your endpoint is down", and the team message names them so everyone knows who's likely on it.

The personal alert is always **in addition to** the org alert, never instead of it, so an outage doesn't go unseen because one owner is on holiday. The owner's own notification preferences still apply, and someone who has left the organization gets nothing, even if a record still names them.

## What happens over time

Ownership survives re-syncs, renames and a resource briefly disappearing from the provider. Deleting the **account** removes its ownership records.

Clear every field and the record is removed.

## Permissions

Reading ownership needs `resources:read`. Setting it needs `resources:write`. It isn't admin-only: whoever can create a resource can say it's theirs.

The owner picker only needs `resources:read`, not `team:read`, so you can record an owner without permission to see roles and membership.

Changes are recorded in the [audit log](../team-and-billing/audit-log.md).

## CLI, MCP and mobile

- `infrawrench ownership` lists everything recorded. Use `infrawrench ownership <query>` to filter by resource, owner or purpose. See the [CLI](../features/cli.md).
- The [MCP server](../features/mcp.md) has `list_resource_ownership`, so an AI assistant can answer "who owns this?" and "what has nobody claimed?" before suggesting a deletion.
- The mobile app shows the owner on each flagged resource in the Savings tab of the Costs screen. Setting an owner is done on web or desktop.

## Related

- [Orphan finder](../features/orphan-finder.md): find resources that look wasted
- [Resource leases](../features/resource-leases.md): the other answer to "why is this still here?"
- [Roles and permissions](../team-and-billing/roles-and-permissions.md)
