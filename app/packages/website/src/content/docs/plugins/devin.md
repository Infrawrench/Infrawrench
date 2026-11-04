---
title: Devin
description: Track Devin ACU spend by product, user, playbook and session tag, and manage sessions, playbooks, knowledge, secrets, automations and members.
sidebar_order: 50
---

Devin is Cognition's AI software engineer. Connect Devin to see what your organization spends in ACUs (Agent Compute Units) as daily cost, and to manage its sessions, playbooks and knowledge.

## What you can manage

- **Organizations**: this month's ACUs per product (Devin sessions, automations, Cascade, terminal, Devin Review) with an estimated cost, this month's sessions, pull requests and searches, and the organization's ACU limits. The **Metrics** tab charts daily ACUs and estimated cost, sessions, pull requests created and merged, searches and daily active users.
- **Sessions**: status, who started the session, its playbook, tags, origin and category, the ACUs it used with an estimated cost, and the pull requests it opened (with their state and a link to each). **Terminate** a running session (you confirm first, and a terminated session can't be resumed), **Archive** or **Unarchive** it, and **Edit** its tags. The **Metrics** tab charts the session's daily ACUs.
- **Playbooks**: create, edit and delete playbooks, including the macro that invokes one and an optional structured output schema. Each playbook shows how many sessions ran it in the last 30 days and how many of their pull requests merged, and the **Metrics** tab charts both.
- **Knowledge notes**: create, edit, **Enable**, **Disable** and delete notes, with their trigger and an optional pinned repository.
- **Secrets**: names, types and notes only. Devin never returns secret values. Add a secret (key and value, site cookie, or TOTP seed) or delete one. To change a value, delete the secret and add it again.
- **Members**: name, email and roles, the ACUs each member used over the last 30 days, and a chart of their daily ACUs.
- **Automations**: triggers, last run and next run. **Enable**, **Disable** or delete an automation.

## Connect your organization

1. In Devin, open **Settings**, then **Service users**, and create a service user.
   - An **organization** service user covers one organization.
   - An **enterprise** service user covers every organization in the enterprise, and you see each of them.
   - A personal access token also works.
2. Give the service user a role that can read what you want to see:
   - Cost data needs **View Org Consumption** (**View Account Consumption** for an enterprise service user).
   - Terminating sessions needs **Manage Org Sessions**.
   - Editing playbooks, knowledge and secrets needs the matching **Manage** permissions.
3. Copy the credential (it starts with `cog_`) and paste it into **API Key** in Infrawrench.

You don't need your organization ID. Infrawrench reads it from the key.

<insert [Devin Add-account form with the API Key filled in and the Price per ACU field showing the default 2.25] here>

**Price per ACU** is the rate used to estimate cost (see below). Change it any time with **Edit credentials** on the account.

## Cost graphs

Devin accounts show up in [cost graphs & budgets](../features/cloud-costs.md) with daily costs:

- **Service** is the product the ACUs went to: Devin sessions, Automations, Cascade, Terminal or Devin Review.
- **Resource** is the session that spent the ACUs, so a session's cost links back to it.
- **Tags**: `organization`, `user` (the person or service user), `playbook`, `session_tag`, `origin` (Slack, the web app, the API, an automation…) and `category` (bug fixing, feature development…). A session with several tags is filed under all of them joined with `+` (for example `backend+urgent`), so totals never count a session twice.
- ACUs that belong to a person but no session (for example Cascade or Devin Review) carry just the `user` tag. Anything else in the organization total carries just `organization`.
- **These amounts are estimates.** Devin reports ACUs but not prices, so Infrawrench multiplies ACUs by the account's **Price per ACU**. The default, $2.25, is Devin's published pay-as-you-go rate. Enterprise contracts set their own rate in the order form. Enter yours so the numbers match your bill.
- Days follow Devin's billing days, which start at midnight Pacific Standard Time (08:00 UTC). Sessions that run for several days keep updating.

## Tips & limits

- Up to 1,000 of each organization's most recent sessions are listed.
- On very busy organizations, some ACUs from sessions that span several days may be counted under the user rather than the session.
- Service users have no names in Devin, so their cost is tagged `Service user <id>`. The service user you connect with is tagged with its own name.
- Devin incidents from [devinstatus.com](https://www.devinstatus.com) appear on the account, and Cloud Agent incidents are flagged on sessions.
