---
title: Agent authentication
description: Let an AI agent register itself, work in a 24-hour trial workspace, and hand it to you when you're ready.
sidebar_order: 12
---

An AI agent can sign itself up for Infrawrench. It gets a real workspace with every paid feature on, no credit card, and a 24-hour clock. When the agent's work is worth keeping, you claim the workspace and the clock stops.

This exists because the alternative is worse. An agent that needs an account has to either ask you to go and make one before it can do anything, or be handed a long-lived API key it keeps forever. Registration lets it start working immediately, and the claim ceremony puts a named person behind it before anything becomes permanent.

## The trial workspace

Registering opens a genuine organization — real cloud accounts, real syncing, real dashboards — with two deliberate limits:

- **It is deleted 24 hours after it is created** unless someone claims it. Everything in it goes: resources, dashboards, cost history, the lot. There is no undelete.
- **The AI chat budget is zero.** Infrawrench's own chat agent will refuse to run. An agent arriving here already has a model of its own, and that model is the one that should be paying for its tokens.

Everything else — connecting AWS, browsing resources, building dashboards, running workflows — works exactly as it does on a paid plan. Inviting teammates needs a person: claim the workspace first, then invite from **Settings → Team**.

<insert The trial countdown banner across the top of an org page, showing roughly 6 hours remaining and the "Claim this workspace" button here>

## Claiming a workspace

The agent asks Infrawrench for a code and shows it to you along with a link. You open the link, sign in, and type the code. That's the whole ceremony.

The code travels from the agent to you directly, in whatever you're already talking in. Infrawrench never emails it — an anonymous registration has no verified address to email, and mailing a code to an address the _agent_ supplied would be a way for an agent to push a claim prompt into somebody else's inbox.

Codes look like `K7MP-2Q9X` and last 15 minutes. If yours expires, ask the agent for another.

<insert The claim page with a code entered, showing the workspace name, the time remaining, and the two radio options here>

### Keep it, or fold it into an organization you already have

At claim time you choose:

**Keep it as its own organization.** Nothing moves. You become the owner and the expiry is cleared. This is the right choice if you're new to Infrawrench.

**Move it into an organization you already have.** The workspace's cloud accounts are re-parented into an organization you already belong to, and the trial workspace is deleted. The accounts re-sync immediately, so resources and metrics rebuild themselves within a poll cycle.

A merge moves the **connection**, not everything. Dashboards, cost centres and anything else the agent authored in the trial do not come across. If you want the trial's metrics and cost history too, tick **bring metrics and cost history across** — it takes a few minutes to appear, and it will change the numbers on existing cost charts in the target organization, which is why it's off by default.

You can only merge into an organization you're already a member of **and can add cloud accounts to** — a merge writes credentials into that organization, so it asks for the same permission connecting an account by hand does (`accounts:write`). Bringing metrics and cost history across additionally needs `costs:write`, because it changes numbers the organization may already be reporting on. Organizations you can't merge into aren't offered in the list.

## After claiming

The workspace becomes a normal organization on the free plan. Two things follow from that:

- **The free plan includes one user and three cloud accounts.** If the agent connected more than three, they all keep working — the limit applies when accounts are _added_, so nothing is disconnected. You just can't add a fourth until you upgrade.
- **The AI chat budget stays at zero** until you raise it under **Settings → General**. Claiming doesn't quietly hand over an inference budget on your behalf.

The agent keeps working, with the same credential, now acting with **your** permissions — never more than you hold yourself. If you're later demoted, the agent narrows with you.

## What an agent can never do

Whatever permissions it inherits, an agent can never:

- manage billing or start a subscription
- mint or read API keys
- invite people
- revoke another agent registration
- delete the organization

These are acts a person performs, and a credential with nobody attached shouldn't perform them. An agent that tries gets a 403 naming the specific thing it attempted.

## Seeing and revoking agents

**Settings → Agent Credentials** lists every agent registration in the organization: what it calls itself, when it was last used, and who claimed it. Revoking one stops its credential working on its next request.

Revoking keeps the row, so audit entries naming that agent stay readable. "What did it do before we cut it off" is the question you'll actually be asking.

<insert The Agent Credentials settings page listing two agents, one claimed and one revoked here>

Note this is a different thing from the **Agents** tab in the sidebar, which is coding-agent VM sessions and has nothing to do with authentication.

## Rate limits

Anonymous registration is limited to 5 workspaces per hour from one address, with a global hourly ceiling on top. An agent that hits the limit should claim the workspace it already has rather than open another.

## For agent developers

The machine-readable version of this page lives at [`/auth.md`](https://app.infrawrench.com/auth.md), which is what the `agent_auth` block in our [protected-resource metadata](./mcp.md) points at. It carries literal `curl` commands and needs no SDK.

The short version:

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

Every poll response carries `trial_expires_in_ms`, not just the ones near the deadline. Use it to warn your user in time rather than after the fact — a workspace that vanishes overnight with no warning is worse than one that was never offered.

Over MCP, the `trial_workspace_status` tool answers the same question.

## See also

- [MCP server](./mcp.md) — the endpoint an agent connects to
- [API keys](../team-and-billing/api-keys.md) — long-lived credentials a person mints
- [Billing and plans](../team-and-billing/billing-and-plans.md) — what the paid plan includes
