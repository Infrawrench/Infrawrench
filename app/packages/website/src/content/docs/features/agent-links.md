---
title: Agent links
description: Connect a platform such as Nibblets so each of its agents gets its own scoped Infrawrench identity.
sidebar_order: 13
---

An agent link lets a platform that runs AI agents (Nibblets is the first) create agents in your organization. Each agent it makes is a separate identity: its own credential, its own name in the audit log and in **Settings → Agent Credentials**, and only the permissions you give it. Nobody hands an agent their own login.

You approve a link once. After that the platform creates, edits and removes its agents on its own, but never beyond the limit you set when you approved it, and never beyond what you yourself are allowed to do.

## Connecting a platform

1. In the platform, start linking Infrawrench (in Nibblets: **Settings → Linked apps → Infrawrench → Link**). It shows you a code like `ABCD-EFGH` and opens Infrawrench's **Connect a platform** page.
2. Sign in if asked. The code survives the sign-in.
3. Check who is asking. The page shows the platform and the name it gave itself. **Only approve a code you started yourself, just now.** If someone sent you the link, deny it.
4. Pick the organization. Only organizations where you can invite people are offered, because connecting a platform is the same kind of decision as adding a member.
5. Tick the **most this platform may ever grant its agents**. The boxes the platform asked for are pre-ticked, and only permissions you hold yourself are offered.
6. Choose **Approve**. The platform picks up its connection within a few seconds.

<insert The Connect a platform page for "Nibblets on PogAir-4", showing the warning, the organization picker and the permission ceiling with Resources (read) and Costs (read) ticked here>

The code expires after 15 minutes and works once.

Infrawrench can also make the link itself: when you create a [Nibblets server](./nibblets.md) from the **Agents** tab with **Link to this organization** ticked, you are the approver and the permissions you tick there are the ceiling. Deleting that server revokes the link.

## What its agents can do

Every agent a platform makes is limited by four things at once, checked again on every request:

- the scopes the platform gave that agent,
- the ceiling you approved for the link,
- your own current role in the organization (if you are demoted, every agent from links you approved narrows with you on its next call), and
- the things no agent can ever do: manage billing, read or mint API keys, change organization settings, invite people, or revoke other agents.

A platform can also confine an agent to some providers ("only AWS"). That narrowing applies to resources, secrets and object storage, and is enforced on the [MCP server](./mcp.md), which is how a linked agent works: each call has to name a provider (a plugin, an account or a resource) and every provider it touches must be allowed. Tools that reach beyond the providers they name, such as the blast-radius report or SSH to an arbitrary host, are not available to a provider-limited agent. On the HTTP API, provider-limited permissions are refused rather than widened.

Over MCP, an agent is only shown the tools it can actually use.

## Managing links and their agents

**Settings → Agent Credentials** has a **Connected platforms** section. Each link shows the platform, who approved it, when, when it was last used and what it may currently grant. Its agents are listed under it with their scopes, providers and last use.

<insert Settings → Agent Credentials with a connected Nibblets platform and two agents nested under it, one with "Only: AWS" here>

- **Edit scopes** on an agent changes what it may do, within the link's ceiling. You can only add permissions you hold yourself.
- **Revoke** on an agent cuts that agent off on its next request.
- **Revoke** on the platform removes the link and every agent it made, at once.

Removing the link from the platform's side does the same. Turning an agent off in the platform, or deleting it there, revokes it here. Revoking keeps the records, so audit entries naming the agent stay readable.

You need permission to invite people to revoke or edit; anyone who can see the team can see the list.

## For platform developers

A platform starts with a device flow and then drives its agents with the link credential (`iwl_...`). The full contract is in the [API reference](../team-and-billing/openapi.md) under **Agent links**; in short:

```bash
# 1. Ask to be linked. Show the user `userCode` and open `verificationUrlComplete`.
curl -X POST https://app.infrawrench.com/api/agent-links/requests \
  -H 'Content-Type: application/json' \
  -d '{"platform": "nibblets", "label": "Nibblets on PogAir-4", "requestedScopes": ["resources:read"]}'

# 2. Poll every `interval` seconds until `approved`, `denied` or `expired`.
#    `approved` carries the link credential, exactly once.
curl -X POST https://app.infrawrench.com/api/agent-links/requests/token \
  -H 'Content-Type: application/json' -d '{"deviceCode": "..."}'

# 3. Read the link: its current ceiling, grouped scopes and connected providers.
curl https://app.infrawrench.com/api/agent-link -H 'Authorization: Bearer iwl_...'

# 4. Make an agent. Its `iwa_` credential is returned once; use it on /api/mcp.
curl -X POST https://app.infrawrench.com/api/agent-link/agents \
  -H 'Authorization: Bearer iwl_...' -H 'Content-Type: application/json' \
  -d '{"externalId": "nibblet-123", "label": "Pog", "scopes": ["resources:read"], "providers": ["aws"]}'
```

Agents can be edited (`PATCH /api/agent-link/agents/{id}`), have their credential rotated (`POST .../rotate`) and be revoked (`DELETE`). `DELETE /api/agent-link` unlinks. A revoked link answers `401` everywhere.

## See also

- [Agent authentication](./agent-auth.md): agents that register themselves and are claimed later
- [MCP server](./mcp.md): the endpoint linked agents use
- [Nibblets servers](./nibblets.md): a Nibblets server set up and linked from the Agents tab
- [Roles and permissions](../team-and-billing/roles-and-permissions.md): the permission strings scopes are made of
