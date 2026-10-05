---
title: Cost visibility and sharing
description: Limit which costs a role, member or API key can see, by cost centre, account or saved filter, and choose who can open or edit each cost report, folder and dashboard.
sidebar_order: 3
---

> Managed on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

Roles decide _what_ someone can do. Two more controls decide _which_ costs and _which_ objects:

- **Cost visibility scopes** limit the cost rows a role, member or API key can see. A team lead scoped to the Platform cost centre sees Platform's spend everywhere and nothing else.
- **Sharing** decides who can open or edit each cost report, report folder and dashboard.

Both narrow what a role already allows. Neither can grant a permission the role lacks.

## Cost visibility scopes

Open **Settings → Cost Visibility** and choose **Add a scope**.

<insert [Settings → Cost Visibility with two scopes listed (a role scoped to a cost centre, an API key scoped to one account) and the scope editor open, showing the cost centre and account pickers and the "Will see" summary] here>

A scope applies to one of:

- a **role**: everyone holding the role,
- a **member**: one person,
- an **API key**: one key, which is useful for a CI job or a reporting script that should only ever read one team's spend.

Pick what the principal can see:

- **Cost centres**: spend the [allocation rules](../features/tag-policy-and-showback.md) assign to these centres, including their sub-centres.
- **Accounts**: all spend on these connected accounts.
- **Saved filter** (optional): a [saved filter](../features/cloud-costs.md) applied on top. Without centres or accounts, the saved filter alone decides.

A cost row is visible when it is on a chosen account **or** allocates to a chosen centre, **and** matches the saved filter if there is one. A scope with nothing picked hides every cost from that principal.

### How scopes combine

Every scope that applies to someone must match a row for them to see it. A member whose role is scoped to Engineering and who also has a member scope for the `prod` account sees only Engineering's spend on `prod`. A scope can only take rows away, so adding one never widens anyone's access. An API key acts as its owner, so a key scope narrows the owner's scope further.

Owners are never scoped: the Owner role always sees all costs, so nobody can lock the organization out of its own spend.

### Where scopes apply

Everywhere costs are read, because the scope is applied where the server builds every cost query rather than page by page:

- cost queries, the Costs panel, cost reports and dashboard cost cards,
- budgets, change alerts and scheduled report deliveries,
- showback, unit costs, forecasts, scenario projections and untagged spend,
- credits, commitments and network flow estimates,
- [AI chat](../features/ai-chat.md), [MCP](../features/mcp.md) tools, the [CLI](../features/cli.md), Slack's `/infrawrench costs` and the [mobile app](../features/mobile-app.md).

Filter pickers only offer values a scoped person can see, so a service name or tag value from another team's spend never appears in a dropdown.

Some figures belong to an account rather than to individual cost rows: credits, commitments and network flow estimates. A scoped person sees these only for accounts their scope grants outright. A scope made only of cost centres, or one with a saved filter, shows none of them.

### What scoped people cannot use

These cover the whole organization by nature, so they return an error for a scoped person:

- [cost exports](../features/cloud-costs.md), [custom cost sources](../features/custom-cost-sources.md), [managed accounts and invoices](../features/managed-accounts.md) (including the pricing preview for a managed account), the [weekly digest](../features/weekly-digest.md) settings and [config as code](../features/config-as-code.md),
- changing roles, member roles, invitations or cost visibility scopes. Any of these could give someone, including a second account of their own, wider visibility than they hold.

[Cost anomaly](../features/cloud-costs.md) findings are detected across all of the organization's spend, so they are hidden from scoped people rather than shown with totals they cannot otherwise see.

### Budgets and alerts created by a scoped person

A budget, change alert or report delivery schedule created by a scoped person only ever measures what that person can see. The scope is resolved again every time the object is evaluated, so narrowing the person's scope later narrows their budgets too, and a budget whose creator leaves the organization stops seeing any spend rather than widening to everything.

Objects created by unrestricted members measure the whole organization, so scoped people do not see them or their alert history. Mobile push notifications for budgets, anomalies, change alerts and other cost alerts are never sent to scoped members for spend outside their scope. Slack and Teams channels are chosen by whoever configured the alert and are unaffected.

### Who can change scopes

- Roles and members: anyone with `team:role:write`.
- An API key: anyone with `team:role:write`, or the key's own owner with `apikeys:write`.

Every change is recorded in the [audit log](./audit-log.md) as `cost_visibility.update` or `cost_visibility.delete`. Deleting a saved filter that a scope uses is refused, because the scope would otherwise stop matching anything.

## Sharing reports and dashboards

Every cost report, report folder and dashboard has a **Share** action. It sets:

- **Everyone in the organization**: _Can edit_ (the default, which is how every object behaves until somebody shares it), _Can view_, or _No access_.
- **People and roles**: _Owner_, _Can edit_ or _Can view_ for individual members or whole roles.

<insert [Share dialog on a cost report: "Everyone in the organization" set to "Can view", the Finance role with "Can edit", one member as "Owner"] here>

Rules:

- The person who creates a report, folder or dashboard is its owner. Owners change sharing; editors change content; viewers open it.
- Deleting needs owner access, or editor access on an object nobody owns (objects created before sharing existed).
- Sharing on a folder reaches every report and subfolder inside it. A folder left at the default adds nothing, so making one report "No access" is not undone by the folder it sits in.
- Sharing never goes beyond a role: opening still needs `costs:read` or `dashboards:read`, editing `costs:write` or `dashboards:write`.
- Admins and owners hold `sharing:override`, which opens and re-shares everything. That is what keeps an object manageable after its owner leaves.
- A report card on a dashboard only appears for people who can open the report itself.

Sharing does not change which costs someone sees: a scoped person opening a shared report still sees only their own slice of it.

## CLI, API and Terraform

```
infrawrench cost-visibility          # every scope in the organization
infrawrench cost-visibility me       # whether your own cost figures are scoped
infrawrench cost-visibility --json
```

The HTTP routes are `GET|PUT /api/org/{orgId}/cost-visibility`, `DELETE /api/org/{orgId}/cost-visibility/{principalKind}/{principalId}` and `GET|PUT|DELETE /api/org/{orgId}/sharing/{objectType}/{objectId}`. `GET /team/me` reports your own scope as `costVisibility`. A refused request from a scoped principal returns `403` with `code: "cost_scope_restricted"`.

The [Terraform provider](../features/terraform-provider.md) manages both: `infrawrench_cost_visibility_scope` and `infrawrench_object_sharing`.
