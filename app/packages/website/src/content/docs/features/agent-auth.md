---
title: Agent authentication
description: Let an AI agent register itself, work in a 24-hour trial workspace, and hand that workspace to you when you're ready to keep it.
sidebar_order: 12
---

An AI agent can sign itself up for Infrawrench. It gets a real workspace with every paid feature turned on, no credit card, and 24 hours to work. When the agent's work is worth keeping, you claim the workspace and the clock stops.

This means an agent can start working right away without asking you to create an account first or holding a long-lived API key. Before anything becomes permanent, a named person (you) claims it.

## The trial workspace

Registering creates a real organization, with real cloud accounts, syncing and dashboards, and two limits:

- **It's deleted 24 hours after it's created** unless someone claims it. Everything in it goes: resources, dashboards, cost history, all of it. It can't be restored.
- **The AI chat budget is zero.** Infrawrench's own chat assistant won't run. The agent already has its own model, which should pay for its own tokens.

Everything else works just like a paid plan: connecting AWS, browsing resources, building dashboards, running workflows. Inviting teammates needs a person, so claim the workspace first, then invite people from **Settings > Team**.

<insert The trial countdown banner across the top of an org page, showing roughly 6 hours remaining and the "Claim this workspace" button here>

## Claim a workspace

1. The agent gives you a code and a link.
2. Open the link and sign in.
3. Type the code.

The agent shares the code with you directly, wherever you're already talking to it. Infrawrench never emails it, so an agent can't use it to send claim prompts to someone else's inbox.

Codes look like `K7MP-2Q9X` and last 15 minutes. If yours expires, ask the agent for a new one.

<insert The claim page with a code entered, showing the workspace name, the time remaining, and the two radio options here>

### Keep it, or move it into an organization you already have

When you claim, you choose one of two options.

**Keep it as its own organization.** Nothing moves. You become the owner and the expiry is removed. Pick this if you're new to Infrawrench.

**Move it into an existing organization.** The workspace's cloud accounts move into an organization you already belong to, and the trial workspace is deleted. The accounts sync again straight away, so resources and metrics fill back in shortly.

Moving brings the **cloud account connections** only. Dashboards, cost centres and anything else the agent made in the trial don't come across. If you also want the trial's metrics and cost history, tick **bring metrics and cost history across**. It takes a few minutes to appear. It's off by default because it changes the numbers on existing cost charts in the target organization.

You can only move it into an organization where you're a member **and** can add cloud accounts (`accounts:write`), the same permission you'd need to connect an account yourself. Bringing metrics and cost history across also needs `costs:write`. Organizations you can't move it into aren't shown in the list.

## After you claim

The workspace becomes a normal organization on the free plan.

- **The free plan includes one user and three cloud accounts.** If the agent connected more than three, they all keep working, because the limit only applies when you add accounts. You just can't add a fourth until you upgrade.
- **The AI chat budget stays at zero** until you raise it under **Settings > General**. Claiming doesn't give out an AI budget on your behalf.

The agent keeps working with the same credential, but now with **your** permissions, and never more than you have. If your role is later reduced, the agent's access shrinks too.

## What an agent can never do

Whatever permissions it has, an agent can never:

- manage billing or start a subscription
- create or read API keys
- invite people
- revoke another agent registration
- delete the organization

These are things a person should do. An agent that tries gets a 403 that names what it attempted.

## See and revoke agents

**Settings > Agent Credentials** lists every agent registration in the organization: what it calls itself, when it was last used and who claimed it. Revoke one and its credential stops working on its next request.

Revoked agents stay in the list, so audit entries that name them stay readable and you can check what they did before you cut them off.

<insert The Agent Credentials settings page listing two agents, one claimed and one revoked here>

Agents created by a connected platform such as Nibblets are listed separately on the same page under **Connected platforms**. See [agent links](./agent-links.md).

This is different from the **Agents** tab in the sidebar, which is for coding-agent VM sessions and has nothing to do with sign-in.

## Rate limits

Anonymous registration is limited to 5 workspaces per hour from one address, plus an overall hourly limit. An agent that hits the limit should claim the workspace it already has instead of opening another.

## For agent developers

The machine-readable version of this page is at [`/auth.md`](https://app.infrawrench.com/auth.md), which the `agent_auth` block in our [protected-resource metadata](./mcp.md) points to. It has ready-to-run `curl` commands and needs no SDK.

In short:

```bash
# 1. Register. The credential is returned once and cannot be recovered.
curl -X POST https://app.infrawrench.com/api/agent/identity \
  -H 'Content-Type: application/json' \
  -d '{"label": "Cost review"}'

# 2. Use it, as a bearer token, against the API or the MCP endpoint.
curl https://app.infrawrench.com/api/org/<org>/resources \
  -H 'Authorization: Bearer iwa_...'

# 3. Ask to be claimed, and show the user the code and the URL together.
curl -X POST https://app.infrawrench.com/api/agent/identity/claim \
  -H 'Authorization: Bearer iwa_...'

# 4. Poll until claimed.
curl https://app.infrawrench.com/api/agent/identity \
  -H 'Authorization: Bearer iwa_...'
```

Every poll response includes `trial_expires_in_ms`. Use it to warn your user well before the workspace is deleted, not after.

Over MCP, the `trial_workspace_status` tool gives you the same information.

## See also

- [MCP server](./mcp.md): the endpoint an agent connects to
- [Agent links](./agent-links.md): scoped agents created by a platform you connected
- [API keys](../team-and-billing/api-keys.md): long-lived credentials a person creates
- [Billing and plans](../team-and-billing/billing-and-plans.md): what the paid plan includes
