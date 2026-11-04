---
title: API keys
description: Create API keys so scripts, CI jobs and tools can work with your Infrawrench organization.
sidebar_order: 5
---

> **Paid plan only.** Available on the web app and, when signed in to a cloud organization, in the desktop app's Settings tab.

API keys let your scripts and CI jobs list resources, create them and read their outputs. A key acts on behalf of the person who created it, and can never do more than that person's role allows.

## Create a key

1. Go to **Settings > API keys > New key**.
2. Give it a name, for example `ci-deploy`.
3. Tick the [scopes](#choose-scopes) it needs. The filter box matches the permission string, so typing `costs:` finds the two cost scopes.
4. Click **Create**.

The token is shown once. Copy it now, because you can't see it again.

![API key create dialog with copy-once warning](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/api-keys/create-copy-once.png)

## Use a key

Send it as a bearer token:

```
Authorization: Bearer iwk_...
```

```sh
curl https://app.infrawrench.com/api/org/$ORG_ID/accounts \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

A key works against every endpoint under `/api/org/<orgId>/`: accounts, resources, costs, dashboards, workflows, deployments, schedules, the audit log and org config. Its scopes decide which of those it can actually call, and a few actions are [off limits to any key](#what-a-key-cannot-do). See the [API reference](./openapi.md) for the full list.

## One key, one organization

A key belongs to the organization you created it in. Using it against a different `<orgId>` returns `403`. If you automate across several organizations, create a key in each one.

## What a key cannot do

Some actions have to be done by a person. They return `403` to any key, even one scoped `*` and owned by an Owner:

- **Creating, revoking and listing API keys.**
- **Billing.** Plan changes, payment methods and the customer portal.
- **Push devices and notification preferences.**
- **Changing team membership:** invites, role assignment, custom roles and removals. Reading the team is allowed.
- **Requesting, approving, denying or revoking [break-glass access](./break-glass-access.md).** Reading the queue is allowed.
- **Requesting, approving, denying, extending, cancelling or revoking [just-in-time access](../features/just-in-time-access.md).** Reading requests and managing policies are allowed.
- **Sharing or joining a [shared console](../features/shared-consoles.md)**, over HTTP or WebSocket. Listing currently shared sessions is allowed.

Your own account settings (password, two-factor, email address, active sessions), creating and deleting organizations, and platform admin pages never accept a key either. They need you to sign in through a browser, and the account security ones need a recent sign-in.

## Revoke a key

Go to **Settings > API keys**, pick the key and click **Revoke**. It stops working straight away. Requests already in progress finish; new ones get `401`.

## Rotate a key

There is no rotate button. Create a new key, update your scripts, then revoke the old one.

## Choose scopes

Each key carries a list of **permission strings** (scopes). They are the same permissions used by [roles](./roles-and-permissions.md), so `resources:read` on a key allows the same endpoints as `resources:read` on a role.

The create dialog groups every permission into infrastructure, cost and billing, dashboards and alerting, automation and deployment, access and credentials, integrations, and organization settings. The filter box matches both the permission string and its label.

Pick the smallest set that does the job. For example:

- A CI deploy key might only need `accounts:read` and `resources:read`.
- A [Terraform provider](../features/terraform-provider.md) key managing cost allocation needs `costs:read` and `costs:write`.
- A sync agent for the desktop app needs `resources:read` and `resources:write`.

Nine permissions don't appear in the picker, because they only cover actions a key [can't do anyway](#what-a-key-cannot-do): `apikeys:read`, `apikeys:write`, `billing:read`, `billing:write`, `team:invite`, `team:role:write`, `team:remove`, `access:request` and `access:approve`.

A key with sync scopes can't read provider credentials. It can only see whether an account has credentials stored. Fetching a credential needs `secrets:read` and is recorded in the audit log.

Wildcards work: `resources:*:read`, `resources:postgres:*`, or `*` for full access. The [API reference](./openapi.md) lists the permission each operation needs under its `x-required-permission` extension, and the `Permission` enum lists every valid string.

### Scopes for specific features

- **AI chat.** `chat:read` lets a key list and inspect [AI chat](../features/ai-chat.md) conversations. `chat:write` lets it send messages and approve destructive tool calls. Usage from a `chat:write` key still counts toward your org's tokens and monthly spend cap. A chat key doesn't widen what the assistant can do: every tool it runs is checked against the key's own scopes, so a chat-only key can talk about your infrastructure but can't read a secret or delete a resource unless you also granted `secrets:read` or `resources:delete`.
- **Push endpoints.** `costs:write` lets a key report your own cost rows and `pages:write` lets it raise an on-call page from a server, through the [push endpoints](../features/server-push.md). Neither is in a built-in role, so the key's owner must be an Admin or Owner, or have a custom role that grants it.
- **Workflows.** Grant what the key needs: `workflows:read` to list and inspect [workflows](../features/workflows.md), `workflows:write` to edit and run them, `workflows:approve` to decide an approval step. Use `workflows:*` only for a key that should have all three. Keys that were active before workflows got their own scopes had the matching workflow scopes added, and you'll see them listed on the key.
- **Older sync scopes.** `sync:read` and `sync:write` are no longer offered and become `resources:read` and `resources:write` automatically. Pick those two directly instead.

## Keys are bounded by their owner

A key's effective permissions are its scopes **combined with** the current role of the person who created it, checked on every request. Plan around two things:

- Demoting a teammate immediately narrows every key they created. A `*` key owned by someone moved from Admin to Member can now only do what a Member can.
- Removing someone from the organization revokes the keys they created there.

For automation that has to survive staff changes, create the key under an account that will stay in the org, not a personal account belonging to someone who might leave.

## See what a key did

Every change made with a key is credited to that key in the [audit log](./audit-log.md). The actor column shows the key's name and prefix as a chip, with the owner underneath. So you see "the `ci-deploy` key Alice created deleted the database", not just "Alice deleted the database". That's what you need to know when a token leaks.

Click the chip, or pick the key from the audit log's key dropdown, to see everything that key did. Over the API, add `?apiKeyId=<id>` to `GET /api/org/<orgId>/audit-logs`. Filtering by user isn't enough here, because a person and all their keys share one user id.

<insert [Audit log filtered to one API key, showing the key name and prefix in the actor column next to the owner's name] here>

## Find keys nobody uses

The [credential hygiene report](./credential-hygiene.md) lists keys that have never been used, keys that have gone quiet, keys with the `*` scope, and keys holding write scopes they never use. There's nothing to turn on.
