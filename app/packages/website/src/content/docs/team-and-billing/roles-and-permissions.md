---
title: Roles and permissions
description: Infrawrench system roles, custom roles, permission strings and what each permission lets your team do.
sidebar_order: 2
---

> Managed on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

Roles control what each person on your team can do. Every action in Infrawrench needs one or more **permissions**. A role is a bundle of permissions, and each member has one role.

## Permission strings

Permissions are colon-separated names. When you grant a permission, you can use `*` as a wildcard in any segment, or a bare `*` to grant everything.

```
accounts:read              # list and view cloud accounts
resources:execute          # SSH, SQL, KV console, exec
resources:postgres:execute # narrow execute to a specific plugin
resources:*:read           # read any resource type
*                          # full access
```

**Settings > Roles** lists every permission, grouped by category (Accounts, Resources, Team, Billing and so on). The same strings work as **API key scopes**. A key with `resources:read` can call every read-only resource endpoint.

![Settings → Roles page showing the three system roles plus one custom role](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/roles-and-permissions/roles-page.png)

## System roles

Every organization has three built-in roles. You can't edit or delete them.

| Role   | Permissions                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | `*`: everything, including billing and deleting the organization.                                                                                                                                                                                                                                                                                                                                    |
| Admin  | Everything except `billing:write` and `org:settings:write`.                                                                                                                                                                                                                                                                                                                                          |
| Member | Read everything; connect to resources (SSH/SQL/exec); use [AI chat](../features/ai-chat.md) (`chat:read`, `chat:write`); manage own dashboards; write, run, and approve [workflows](../features/workflows.md) (`workflows:read`, `workflows:write`, `workflows:approve`); view cost graphs and budgets (`costs:read`, `budgets:read`; creating budgets needs `budgets:write`, held by Admin and up). |

When new permissions are added, the system roles pick them up automatically.

Two permissions aren't in any system role, because they let unattended code write into your organization:

- `costs:write`: [push cost rows](../features/server-push.md#cost-rows) from your own systems.
- `pages:write`: [raise an on-call page](../features/server-push.md#paging) from your own systems.

Grant them with a scoped [API key](./api-keys.md), or add them to a custom role. Admin and Owner hold them through their wildcards.

If someone only needs a permission now and then, try [break-glass access](./break-glass-access.md) instead of widening their role. They ask for exactly that permission, for as long as they need it, and it lapses on its own.

## Custom roles

Owners and anyone with `team:role:write` can create roles:

1. Go to **Settings > Roles > New role**.
2. Pick permissions from the list, or paste wildcard patterns (for example `resources:postgres:*`) into the advanced field.
3. Save.

![Custom-role edit form with permissions grouped by category, wildcard input visible](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/roles-and-permissions/custom-role-editor.png)

You can't delete a custom role while any member or pending invitation still uses it. Reassign or revoke them first.

### Set a default dashboard for a role

Each role's card, built-in roles included, has a **Default dashboard** picker. That's the dashboard members with the role land on when they haven't picked their own. Changing it needs `org:settings:write`, not `team:role:write`, and the dashboard must already be shared with the role. See [default dashboards](../features/dashboard.md#default-dashboards).

## Assign a role

Go to **Settings > Team**, open the member, and use the role picker. You can't reassign the owner role here. Have the existing owner promote someone first.

![Team page member row with the new role picker dropdown open](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/roles-and-permissions/team-role-picker.png)

You can't give out more authority than you hold:

1. A role you assign must fit within your own permissions. An admin (who has no `billing:write`) can't move someone onto a custom role that grants it.
2. Only an owner can grant the owner role, or change an owner's role.

Both rules also apply when you **invite** someone.

## API key scopes

API keys use the same permission strings as roles. When you create a key, pick the exact scopes it should have. Wildcards work the same way. Older keys with the deprecated `sync:read` / `sync:write` scopes are renamed automatically the next time they're used. Some older keys also had matching workflow scopes added once, when workflows got their own permissions. You can see those scopes on the key.

A key never has more authority than its owner. It can only do what both its scopes and its creator's current role allow, checked on every call. Demoting someone narrows their keys immediately.

Removing someone from the organization revokes the keys they created in it.

## What each permission covers

The same permissions apply everywhere, not just in the web UI.

### HTTP API

Checked per route. See `x-required-permission` in the [API reference](./openapi.md).

### AI chat and MCP

Using [AI chat](../features/ai-chat.md) or [MCP](../features/mcp.md) at all needs `chat:read` / `chat:write`. Each tool then needs its own permission before it runs. A member who can't delete a resource over the API can't delete one by asking the assistant either. Destructive tools are checked again when you approve them.

### Terminals and live sessions

SSH terminals, the SQL console, Kubernetes exec and port-forward, and Linux apps need `resources:execute`, whether you sign in through the browser or use an API key. A key or agent is held to its own scopes here too, so a key scoped only to `resources:execute` can't start a workflow run or a deploy this way, even if its owner could.

### Workflows

- `workflows:read`: list workflows, read their source, run history and metrics, and see pending approval requests. Members hold it.
- `workflows:write`: create, edit, delete and run workflows, including live debug runs in the editor.
- `workflows:approve`: decide a request raised by `infra.waitForApproval(...)`. Kept separate so a custom role can grant authorship without sign-off, or sign-off without authorship.

All three are in the Member role. The split is there for custom roles.

`workflows:write` lets you start a run, but it doesn't decide what the run may do. Every operation in a run is checked against the permissions of the user it acts for, using the same strings as the API: `infra.…create()` needs `resources:write`, `.delete()` needs `resources:delete`, `.ssh()` and `.query()` need `resources:execute`, and SFTP writes need `storage:write`.

- Manual runs act for whoever started them.
- Scheduled, git-triggered and budget-triggered runs act for **whoever last edited the workflow's code** (its source, trigger or assigned secrets). Editing someone else's workflow makes it run as you. If the last editor leaves the organization, the workflow can no longer do anything privileged.
- Editing a workflow that has secrets assigned also needs `secrets:read`.

If a run fails with a permission error, the message names the exact permission to ask for. See [What a run is allowed to do](../features/workflows.md#what-a-run-is-allowed-to-do).

Some older custom roles and API keys that granted `dashboards:read` / `dashboards:write` had matching workflow permissions added once, so nobody lost access. They show up ticked in the role editor, and you can untick them. Custom graphs still use the dashboard permissions.

### Deploys

[Deploys](../features/infrafile.md) use three permissions:

- `deployments:read`: deploy history and a repository's declared environments. Members hold it.
- `deployments:plan`: runs the repository's `plan()`, which executes its code against your accounts but builds and ships nothing. Members hold it. A custom role can withhold it while keeping history.
- `deployments:write`: build, deploy and roll back. Admin and Owner only.

A `planOnly` run needs `deployments:plan` and a real deploy needs `deployments:write`.

### Config as code

[Config as code](../features/config-as-code.md) has its own pair:

- `config:read`: export the organization's configuration, and preview what applying a document would change.
- `config:write`: apply one.

You also need the read (or write) permission for every section involved, so `config:write` can't get around a role that withholds, say, `workflows:write`. Export fails rather than leaving out a section you can't read. Admin and Owner hold both through their wildcards. Members hold neither.

### IaC reconciliation

[IaC reconciliation](../features/iac-reconciliation.md) has its own pair:

- `iac:read`: see which resources Terraform manages, which have drifted and which were made by hand, and generate the `import` blocks to adopt them. **Members hold it.**
- `iac:write`: upload and delete Terraform state documents. Admin and Owner only.

### Managed accounts and invoices

[Managed accounts and invoices](../features/managed-accounts.md) hold your customers' contact details and quoted prices, so they have their own three permissions:

- `invoices:read`: customers, invoices, line items, CSV and PDF downloads, and billing profiles.
- `invoices:write`: add a customer, raise a draft invoice, edit its period, delete a draft, create and edit billing profiles, and assign cost centres and accounts in bulk. None of it is visible outside the organization.
- `invoices:issue`: approve, send and void. Approving freezes the figures, sending emails the invoice to the customer, and voiding withdraws one they already have.

A common setup: a billing clerk holds `read` and `write` to prepare invoices, and only the finance lead holds `issue`. Members hold none of the three. Admin and Owner hold all three.

### Break-glass access

[Break-glass access](./break-glass-access.md) uses three permissions:

- `access:read`: see the queue, live elevations and history. Members hold it.
- `access:request`: raise and withdraw your own requests. Members hold it.
- `access:approve`: approve, deny or revoke anyone's elevation. **Not** included in `team:role:write`, so you can choose who approves elevations separately from who changes roles.

A live grant applies everywhere the person works, but not to API keys or custom graphs.

### Session recordings

[Session recordings](../features/session-recording.md) have their own pair:

- `session-recordings:read`: list, watch and download recorded SSH sessions.
- `session-recordings:write`: change the organization's recording policy and delete recordings.

Neither is in the Member role. A custom role with read but not write suits a compliance reviewer who should watch recordings but not change the policy or delete them. Watching a recording is itself audit-logged.

### Cost visibility and sharing

[Cost visibility and sharing](./cost-visibility.md) narrow a role further rather than adding permissions. A cost visibility scope limits _which cost rows_ a role, member or API key sees. Sharing limits _which reports, folders and dashboards_ someone can open or edit. `sharing:override` (held by Admin and Owner) opens and re-shares everything. Scopes are managed with `team:role:write`. A cost-scoped person can't change roles, invitations or scopes.

## Audit trail

Every permission-sensitive action is recorded in the [audit log](./audit-log.md), including creating, editing and deleting roles and changing a member's role.
