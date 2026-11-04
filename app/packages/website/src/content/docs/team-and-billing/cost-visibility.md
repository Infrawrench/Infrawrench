---
title: Cost visibility and sharing
description: Limit which costs a role, member or API key can see, by cost centre, account or saved filter, and choose who can open or edit each cost report, folder and dashboard.
sidebar_order: 3
---

> Managed on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

Roles decide _what_ someone can do. Two more controls decide _which_ costs and _which_ objects they see:

- **Cost visibility scopes** limit the cost rows a role, member or API key can see. A team lead scoped to the Platform cost centre sees Platform's spend everywhere, and nothing else.
- **Sharing** decides who can open or edit each cost report, report folder and dashboard.

Both only narrow what a role already allows. Neither can grant a permission the role lacks.

## Add a cost visibility scope

1. Open **Settings > Cost Visibility**.
2. Choose **Add a scope**.
3. Pick who it applies to, then what they can see.

<insert [Settings → Cost Visibility with two scopes listed (a role scoped to a cost centre, an API key scoped to one account) and the scope editor open, showing the cost centre and account pickers and the "Will see" summary] here>

A scope applies to one of:

- a **role**: everyone holding the role
- a **member**: one person
- an **API key**: one key. Useful for a CI job or reporting script that should only ever read one team's spend.

Then choose what they can see:

- **Cost centres**: spend the [allocation rules](../features/tag-policy-and-showback.md) assign to these centres, including their sub-centres.
- **Accounts**: all spend on these connected accounts.
- **Saved filter** (optional): a [saved filter](../features/cloud-costs.md) applied on top. With no centres or accounts picked, the saved filter alone decides.

A cost row is visible when it is on a chosen account **or** allocates to a chosen centre, **and** matches the saved filter if there is one. A scope with nothing picked hides every cost.

### How scopes combine

Every scope that applies to someone must match a row for them to see it. If a member's role is scoped to Engineering and they also have a member scope for the `prod` account, they see only Engineering's spend on `prod`. Adding a scope never widens anyone's access. An API key acts as its owner, so a key scope narrows the owner's scope further.

Owners are never scoped. The Owner role always sees all costs, so nobody can lock the organization out of its own spend.

Scopes can't use a [virtual tag](../features/virtual-tags.md) yet. If a scope's saved filter, or the allocation rules of one of its cost centres, reads a virtual tag, the scope matches nothing and the person sees no costs. Define these scopes by account, by cost centre rules on provider tags, or by a saved filter on provider tags.

### Where scopes apply

Everywhere costs show up:

- cost queries, the Costs panel, cost reports and dashboard cost cards
- budgets, change alerts and scheduled report deliveries
- showback, unit costs, forecasts, scenario projections and untagged spend
- credits, commitments and network flow estimates
- [AI chat](../features/ai-chat.md), [MCP](../features/mcp.md) tools, the [CLI](../features/cli.md), Slack's `/infrawrench costs` and the [mobile app](../features/mobile-app.md)

Filter pickers only offer values a scoped person can see, so a service name or tag value from another team's spend never appears in a dropdown.

Credits, commitments and network flow estimates belong to an account rather than to individual cost rows. A scoped person sees them only for accounts their scope grants outright. A scope made only of cost centres, or one with a saved filter, shows none of them.

### What scoped people can't use

These cover the whole organization, so they return an error for a scoped person:

- [cost exports](../features/cloud-costs.md), [custom cost sources](../features/custom-cost-sources.md), [managed accounts and invoices](../features/managed-accounts.md) (including the pricing preview for a managed account), [weekly digest](../features/weekly-digest.md) settings and [config as code](../features/config-as-code.md)
- changing roles, member roles, invitations or cost visibility scopes, since any of these could give someone wider visibility than they hold

[Cost anomaly](../features/cloud-costs.md) findings are hidden from scoped people, because they are detected across all of the organization's spend.

### Budgets and alerts made by a scoped person

A budget, change alert or report delivery schedule created by a scoped person only measures what that person can see. If you narrow their scope later, their budgets narrow too. If they leave the organization, their budgets stop seeing any spend rather than widening to everything.

Budgets and alerts made by unrestricted members measure the whole organization, so scoped people don't see them or their alert history. Mobile push notifications for cost alerts are never sent to scoped members for spend outside their scope. Slack and Teams channels are chosen by whoever set up the alert and are unaffected.

### Who can change scopes

- Roles and members: anyone with `team:role:write`.
- An API key: anyone with `team:role:write`, or the key's own owner with `apikeys:write`.

Every change is recorded in the [audit log](./audit-log.md) as `cost_visibility.update` or `cost_visibility.delete`. You can't delete a saved filter that a scope uses.

## Sharing reports and dashboards

Every cost report, [resource report](../features/resource-reports.md), [network flow report](../features/network-flow-reports.md), report folder and dashboard has a **Share** action. It sets:

- **Everyone in the organization**: _Can edit_ (the default until somebody shares it), _Can view_, or _No access_.
- **People and roles**: _Owner_, _Can edit_ or _Can view_ for individual members or whole roles.

<insert [Share dialog on a cost report: "Everyone in the organization" set to "Can view", the Finance role with "Can edit", one member as "Owner"] here>

How it works:

- Whoever creates a report, folder or dashboard owns it. Owners change sharing, editors change content, viewers open it.
- Deleting needs owner access, or editor access on an object nobody owns (objects created before sharing existed).
- Sharing on a folder reaches every report and subfolder inside it. A folder left at the default adds nothing, so setting one report to "No access" isn't undone by its folder.
- Sharing never goes beyond a role. Opening still needs `costs:read` or `dashboards:read`, and editing needs `costs:write` or `dashboards:write`. A resource report needs `resources:read` to open and `resources:write` to edit, and its cost columns still need `costs:read`.
- [Saved views over savings findings](../features/savings-findings.md#saved-views) share the same way, with the creator as owner. Opening one needs `resources:read`, editing it needs `resources:write`.
- Admins and owners hold `sharing:override`, which opens and re-shares everything. That keeps an object manageable after its owner leaves.
- A report card on a dashboard only appears for people who can open the report itself.

Sharing doesn't change which costs someone sees. A scoped person opening a shared report still sees only their own slice.

## CLI, API and Terraform

```
infrawrench cost-visibility          # every scope in the organization
infrawrench cost-visibility me       # whether your own cost figures are scoped
infrawrench cost-visibility --json
```

The HTTP routes are `GET|PUT /api/org/{orgId}/cost-visibility`, `DELETE /api/org/{orgId}/cost-visibility/{principalKind}/{principalId}` and `GET|PUT|DELETE /api/org/{orgId}/sharing/{objectType}/{objectId}`. `GET /team/me` reports your own scope as `costVisibility`. A refused request from a scoped principal returns `403` with `code: "cost_scope_restricted"`.

The [Terraform provider](../features/terraform-provider.md) manages both: `infrawrench_cost_visibility_scope` and `infrawrench_object_sharing`.
