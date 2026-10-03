---
title: Anthropic
description: Claude models, Message Batches, Files and Skills, plus workspaces, workspace members, organization members, invites, API keys, rate limits, usage, Claude Code analytics and cost reporting with an Admin API key.
sidebar_order: 31
---

## What you can manage

- **Models**: every Claude model this key is entitled to call, with its real context window, output cap, and the full capability matrix: vision, PDF input, batch eligibility, citations, code execution, structured outputs, extended thinking and context management. Read-only, with a usage chart.
- **Message Batches**: asynchronous batch jobs with their per-status request counters. Cancel one while it is in progress; delete it once processing has ended.
- **Files**: anything uploaded through the Files API and referenced from a content block by `file_id`, with its expiry when one was set at upload (delete). Expiring files show up on the [Expiry radar](../features/expiry-radar.md).
- **Skills**: custom Agent Skills uploaded to the key's workspace plus Anthropic's pre-built ones (pptx, xlsx, docx, pdf), with each Skill's version history. Copy a Skill's `skill_id` into a request's `container.skills`, or delete a custom Skill together with all of its versions.
- **Workspaces**: the boundary API keys, files, batches and rate limits are scoped to. Create with a display colour and data residency (allowed and default inference geo), then edit the name, colour, geos and tags, or archive. Each workspace page lists its effective rate limits, marking which values are workspace overrides and which are inherited from the organization, and its Metrics tab charts the workspace's daily cost next to its token usage. Admin key only.
- **Workspace members**: who can use each workspace and with which workspace role (user, restricted developer, developer, admin, billing). Add an existing organization member from a picker, change their role, or remove them. Also listed under each workspace. Admin key only.
- **Organization members**: role changes and removal, with a usage chart of the member's API tokens and their Claude Code activity (sessions, lines added and removed, commits, pull requests, edit acceptance rate, estimated cost), and a **Logs** tab of what they did in the organization from the Compliance API Activity Feed. Admin key only.
- **Invites**: send and revoke. Admin key only.
- **API keys**: listed, renamed, and moved between active, inactive and archived, with a per-key chart of token usage and of Claude Code activity run on that key. Shows whether the key belongs to a workspace or to the whole organization, and whether it acts as a user or a service account. Never created or deleted. Admin key only.
- **Rate limits**: the organization's configured limits per model family (requests, input tokens and output tokens per minute) and per API surface (Message Batches, Files, Token Counting, Skills, web search). Read-only. Admin key only.

## Credentials

Anthropic splits its API across two credentials that share a prefix but nothing else.

**API Key** (required) — Console → **Settings → API keys**. Starts `sk-ant-api`. This drives Models, Message Batches, Files and Skills. It is not an admin key and returns `401` on every `/v1/organizations/*` endpoint.

**Admin API Key** (optional) — Console → **Settings → Admin keys**. Starts `sk-ant-admin`, and only an organization admin can provision one. It unlocks the **Workspaces**, **Workspace Members**, **Organization Members**, **Invites**, **API Keys** and **Rate Limits** sections plus the **usage, Claude Code and cost charts**, all of which live under `/v1/organizations/*`. Leave it blank and everything else keeps working; those sections simply come back empty.

The Admin API does not exist on individual (non-organization) accounts, so there is nothing to add on a personal plan.

![Anthropic Add-account form showing the required API Key field and the optional Admin API Key field with its admin-only description](https://agent-assets.infrawrench.com/docs-screenshots/plugins/anthropic/add-account.png)

## Costs

With an admin key attached, spend is collected from `GET /v1/organizations/cost_report`. That endpoint is **daily-granularity only** — there is no hourly cost — and can be grouped by description and by workspace, so cost views attribute Claude spend per service and per workspace. Up to a year of history is available, with the last three days re-fetched each sync because Anthropic restates them.

![Cost view filtered to an Anthropic account, showing daily spend broken down by workspace](https://agent-assets.infrawrench.com/docs-screenshots/plugins/anthropic/cost-graph.png)

## Tips & limits

- **There is no speech API.** Anthropic ships no text-to-speech or transcription endpoint of any kind, so this plugin has no [Speech tab](../features/speech-testing.md) — not an omission, just an absence.
- **Archiving a workspace is irreversible and immediately revokes every API key scoped to it.** There is no unarchive endpoint; the only way back is a new workspace and new keys. That is why archiving is a confirm-guarded header action rather than an ordinary delete button. Historical usage and cost data survives.
- **API keys can be listed and renamed but never created or deleted.** New keys can only be minted in the Claude Console, "for security reasons". Revoking one is modelled as a status change to `inactive`, which is what the API actually does.
- **Batch results come back in arbitrary order.** The JSONL at `results_url` is not in submission order — match rows back to requests on `custom_id`, never on position.
- **Batches expire 24 hours after creation** and are billed at half the interactive rate. Up to 100,000 requests fit in one.
- **Invites expire after 21 days and the expiry cannot be changed.** On seat-based plans an invite consumes a seat from the lowest tier with availability and fails with a `400` when none is free.
- **Not every role can be assigned over the API.** `admin`, `membership_admin`, `owner` and `primary_owner` are Console-only, and members holding them cannot be removed through the API either. The roles you can set are `user`, `developer`, `billing`, `claude_code_user` and, on Claude Enterprise, `managed`.
- **The Default Workspace never appears in the workspace list**, so it has no page, no members list and no rate-limit overrides here; that is Anthropic's behaviour, not a missing row. Every organization member can already use it.
- **Rate limits are read-only.** Organization limits follow your usage tier, and workspace overrides are set on the workspace's **Rate limits** tab in the Claude Console. The API reads both but changes neither.
- **Workspace Billing can't be assigned when adding a member.** Add them with another role, then edit the membership.
- **Claude Code analytics are daily and per person.** The chart on an organization member fetches one day at a time (up to the last 31 days of the selected range) and matches the member by email. Activity through Bedrock, Vertex AI or Microsoft Foundry is not included, and the most recent hour is withheld by Anthropic.
- **Workspace cost is daily and excludes today.** It comes from the same cost report as cost collection, grouped by workspace, so the chart's newest point is yesterday.
- **Claude Code on an API key is matched by the key's name.** The analytics report identifies API-key usage by name only, so two keys sharing a name share a chart.
- **A member's Logs tab needs the Compliance API.** It reads `GET /v1/compliance/activities` filtered to the member. An Admin API key can read that feed only if an organization admin turned on the Compliance API (Console → **Settings → Security**) before the key was created, and nothing is recorded from before it was turned on. Without it the tab says so instead of showing events.
- **Service accounts aren't listed.** Anthropic's service-account endpoints only accept an OAuth token with the `org:admin` scope, not an Admin API key. Keys that act as a service account still show up under API keys.
