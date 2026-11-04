---
title: Anthropic
description: Claude models, Message Batches, Files and Skills, plus workspaces, workspace members, organization members, invites, API keys, rate limits, usage, Claude Code analytics and cost reporting with an Admin API key.
sidebar_order: 31
---

Connect Anthropic to manage your Claude API resources, see what your organization spends, and administer members, workspaces and keys.

## What you can manage

- **Models**: every Claude model your key can call, with its context window, output cap, and capabilities: vision, PDF input, batch eligibility, citations, code execution, structured outputs, extended thinking and context management. Read-only, with a usage chart.
- **Message Batches**: batch jobs with their request counts by status. Cancel one while it's in progress, or delete it once processing has ended.
- **Files**: anything uploaded through the Files API and referenced from a content block by `file_id`, with its expiry if one was set at upload. You can delete files. Expiring files show up on the [Expiry radar](../features/expiry-radar.md).
- **Skills**: custom Agent Skills uploaded to the key's workspace plus Anthropic's pre-built ones (pptx, xlsx, docx, pdf), with each Skill's version history. Copy a Skill's `skill_id` into a request's `container.skills`, or delete a custom Skill and all its versions.
- **Workspaces**: the boundary that API keys, files, batches and rate limits belong to. Create one with a display colour and data residency (allowed and default inference geo), then edit the name, colour, geos and tags, or archive it. Each workspace page lists its effective rate limits, showing which are workspace overrides and which come from the organization. Its Metrics tab charts daily cost next to token usage. Admin key only.
- **Workspace members**: who can use each workspace, and with which role (user, restricted developer, developer, admin, billing). Add an existing organization member from a picker, change their role, or remove them. Also listed under each workspace. Admin key only.
- **Organization members**: change roles or remove members. Each member has a usage chart of their API tokens and Claude Code activity (sessions, lines added and removed, commits, pull requests, edit acceptance rate, estimated cost), and a **Logs** tab of what they did in the organization, from the Compliance API Activity Feed. Admin key only.
- **Invites**: send and revoke. Admin key only.
- **API keys**: list, rename, and move between active, inactive and archived, with a per-key chart of token usage and Claude Code activity. Shows whether a key belongs to a workspace or the whole organization, and whether it acts as a user or a service account. You can't create or delete keys here. Admin key only.
- **Rate limits**: your organization's limits per model family (requests, input tokens and output tokens per minute) and per API surface (Message Batches, Files, Token Counting, Skills, web search). Read-only. Admin key only.

## Credentials

Anthropic uses two separate keys. They share a prefix but nothing else.

**API Key** (required): in the Console under **Settings > API keys**. It starts with `sk-ant-api`. This covers Models, Message Batches, Files and Skills. It isn't an admin key, so it returns `401` on every `/v1/organizations/*` endpoint.

**Admin API Key** (optional): in the Console under **Settings > Admin keys**. It starts with `sk-ant-admin`, and only an organization admin can create one. It adds the **Workspaces**, **Workspace Members**, **Organization Members**, **Invites**, **API Keys** and **Rate Limits** sections, plus the **usage, Claude Code and cost charts**. Leave it blank and everything else still works; those sections just stay empty.

Individual (non-organization) accounts have no Admin API, so there's nothing to add on a personal plan.

For a **Claude Enterprise** organization, put an Admin API key created in claude.ai (**Organization settings > API**) in the same field, with the `read:members` scope (and `write:members` to remove members). Enterprise keys only reach members and invites, so the Console-only sections stay empty.

**Claude Enterprise Analytics API Key** (optional, under advanced settings): created by the primary owner in claude.ai under **Organization settings > API**, with the `read:analytics` scope. It supplies each member's last activity for [Seats](#seats). Admin keys can't call the Analytics API and Analytics keys can't call the Admin API, so it has its own field.

![Anthropic Add-account form showing the required API Key field and the optional Admin API Key field with its admin-only description](https://agent-assets.infrawrench.com/docs-screenshots/plugins/anthropic/add-account.png)

## Costs

With an admin key attached, your Claude spend shows up in cost views, broken down per service and per workspace. Costs are **daily only**; Anthropic has no hourly cost. Up to a year of history is available, and the last three days can change because Anthropic restates them.

![Cost view filtered to an Anthropic account, showing daily spend broken down by workspace](https://agent-assets.infrawrench.com/docs-screenshots/plugins/anthropic/cost-graph.png)

## Seats

Members of a **Claude Enterprise** organization appear on the **Seats** page as paid Claude seats. There you can find idle seats and people paying for both Claude and another AI assistant, based on your organization's inactivity threshold.

- **Who appears**: every organization member, with their join date. **Console organizations report no seats**, because they're pay-as-you-go with no per-seat charge. An organization whose members all have the plain `user` role also reports none, since it can't be told apart from a Console one. The **Claude Team** plan has no Admin API, so Team seats aren't available.
- **Activity**: with the Analytics API key, you see each member's last activity day across chat, Claude Code, Cowork and the other Claude products, over your inactivity threshold (up to 366 days, and never before 1 January 2026, when the data starts). Anthropic's data runs about two days behind, so those days don't count. Without the key, or while Anthropic has last-activity reporting turned off for your organization, activity is unknown and Claude seats are never called idle.
- **Price**: the published Enterprise list price of $20 per seat per month, billed annually, labelled as an estimate. Usage is billed separately at API rates and isn't part of the seat price. Negotiated and seat-based Enterprise contracts differ.
- **Remove** deletes the member and returns their seat to your organization's pool. You keep paying for the seat until you lower the seat count in claude.ai billing. Owners, membership admins and the primary owner can't be removed through the API, and members provisioned by SCIM are removed in your identity provider.
- **Scopes**: `read:members` on the Admin key to list seats, `write:members` to remove them, and `read:analytics` on the Analytics key for activity.

## Tips & limits

- **There's no speech API.** Anthropic has no text-to-speech or transcription endpoint, so there's no [Speech tab](../features/speech-testing.md) for this provider.
- **Archiving a workspace can't be undone, and it immediately revokes every API key in it.** To go back, you'd need a new workspace and new keys, so you'll be asked to confirm. Historical usage and cost data is kept.
- **You can list and rename API keys, but not create or delete them.** Create new keys in the Claude Console. To revoke a key, set its status to `inactive`.
- **Batch results come back in any order.** The JSONL at `results_url` isn't in submission order, so match rows to requests by `custom_id`, never by position.
- **Batches expire 24 hours after creation** and are billed at half the interactive rate. One batch holds up to 100,000 requests.
- **Invites expire after 21 days, and you can't change that.** On seat-based plans, an invite takes a seat from the lowest tier with space and fails with a `400` when none is free.
- **Some roles can't be assigned over the API.** `admin`, `membership_admin`, `owner` and `primary_owner` are Console-only, and members with those roles can't be removed through the API either. The roles you can set are `user`, `developer`, `billing`, `claude_code_user` and, on Claude Enterprise, `managed`.
- **The Default Workspace isn't in the workspace list**, so it has no page, members list or rate-limit overrides here. Anthropic doesn't list it. Every organization member can already use it.
- **Rate limits are read-only.** Organization limits follow your usage tier. Set workspace overrides on the workspace's **Rate limits** tab in the Claude Console.
- **You can't give Workspace Billing when adding a member.** Add them with another role, then edit the membership.
- **Claude Code analytics are daily and per person.** A member's chart covers up to the last 31 days of the selected range and matches the member by email. Activity through Bedrock, Vertex AI or Microsoft Foundry isn't included, and Anthropic holds back the most recent hour.
- **Workspace cost is daily and excludes today**, so the chart's newest point is yesterday.
- **Claude Code on an API key is matched by the key's name.** Two keys with the same name share a chart.
- **A member's Logs tab needs the Compliance API.** An organization admin must turn it on (Console > **Settings > Security**) before the Admin API key is created, and nothing from before it was turned on is recorded. Without it, the tab tells you so instead of showing events.
- **Service accounts aren't listed.** Anthropic only lists them for an OAuth token with the `org:admin` scope, not an Admin API key. Keys that act as a service account still show under API keys.
