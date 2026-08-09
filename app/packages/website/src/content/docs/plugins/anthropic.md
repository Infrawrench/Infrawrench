---
title: Anthropic
description: Claude models, Message Batches and Files, plus workspaces, members, invites, API keys, usage and cost reporting with an Admin API key.
sidebar_order: 31
---

## What you can manage

- **Models** — every Claude model this key is entitled to call, with its real context window, output cap, and the full capability matrix: vision, PDF input, batch eligibility, citations, code execution, structured outputs, extended thinking and context management. Read-only, with a usage chart.
- **Message Batches** — asynchronous batch jobs with their per-status request counters. Cancel one while it is in progress; delete it once processing has ended.
- **Files** — anything uploaded through the Files API and referenced from a content block by `file_id` (delete).
- **Workspaces** — the boundary API keys, files, batches and rate limits are scoped to. Create, rename, and archive. Admin key only.
- **Organization members** — role changes and removal. Admin key only.
- **Invites** — send and revoke. Admin key only.
- **API keys** — listed, renamed, and moved between active, inactive and archived. Never created or deleted. Admin key only.

## Credentials

Anthropic splits its API across two credentials that share a prefix but nothing else.

**API Key** (required) — Console → **Settings → API keys**. Starts `sk-ant-api`. This drives Models, Message Batches and Files. It is not an admin key and returns `401` on every `/v1/organizations/*` endpoint.

**Admin API Key** (optional) — Console → **Settings → Admin keys**. Starts `sk-ant-admin`, and only an organization admin can provision one. It unlocks the **Workspaces**, **Organization Members**, **Invites** and **API Keys** sections plus the **usage and cost charts** — all of which live under `/v1/organizations/*`. Leave it blank and everything else keeps working; those four sections simply come back empty.

The Admin API does not exist on individual (non-organization) accounts, so there is nothing to add on a personal plan.

![Anthropic Add-account form showing the required API Key field and the optional Admin API Key field with its admin-only description](https://agent-assets.infrawrench.com/docs/screenshots/plugins/anthropic-add-account.png)

## Costs

With an admin key attached, spend is collected from `GET /v1/organizations/cost_report`. That endpoint is **daily-granularity only** — there is no hourly cost — and can be grouped by description and by workspace, so cost views attribute Claude spend per service and per workspace. Up to a year of history is available, with the last three days re-fetched each sync because Anthropic restates them.

![Cost view filtered to an Anthropic account, showing daily spend broken down by workspace](https://agent-assets.infrawrench.com/docs/screenshots/plugins/anthropic-costs.png)

## Tips & limits

- **There is no speech API.** Anthropic ships no text-to-speech or transcription endpoint of any kind, so this plugin has no [Speech tab](../features/speech-testing.md) — not an omission, just an absence.
- **Archiving a workspace is irreversible and immediately revokes every API key scoped to it.** There is no unarchive endpoint; the only way back is a new workspace and new keys. That is why archiving is a confirm-guarded header action rather than an ordinary delete button. Historical usage and cost data survives.
- **API keys can be listed and renamed but never created or deleted.** New keys can only be minted in the Claude Console, "for security reasons". Revoking one is modelled as a status change to `inactive`, which is what the API actually does.
- **Batch results come back in arbitrary order.** The JSONL at `results_url` is not in submission order — match rows back to requests on `custom_id`, never on position.
- **Batches expire 24 hours after creation** and are billed at half the interactive rate. Up to 100,000 requests fit in one.
- **Invites expire after 21 days and the expiry cannot be changed.** On seat-based plans an invite consumes a seat from the lowest tier with availability and fails with a `400` when none is free.
- **Not every role can be assigned over the API.** `admin`, `membership_admin`, `owner` and `primary_owner` are Console-only, and members holding them cannot be removed through the API either. The roles you can set are `user`, `developer`, `billing`, `claude_code_user` and, on Claude Enterprise, `managed`.
- **The Default Workspace has no id** and never appears in the workspace list — that is Anthropic's behaviour, not a missing row.
