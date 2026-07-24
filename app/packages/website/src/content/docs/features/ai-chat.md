---
title: AI chat
description: Drive your infrastructure through a Claude-powered agent — same tools as the UI, with a human-in-the-loop for destructive actions.
sidebar_order: 12
---

> **Cloud feature**; metered separately from your seat plan. Available in the web app and — when signed in to Infrawrench Cloud — in the desktop app, where it proxies through the web backend.

Infrawrench ships an in-app **AI chat** powered by Anthropic Claude. The model has access to the same tools your UI uses — listing resources, inspecting outputs, running SQL queries, executing Docker commands, rotating secrets, attaching disks, applying manifests — and routes every destructive action through a UI approval step.

<insert [Chat page with a streamed assistant reply and a pending-approval card for a delete-resource tool use] here>

<insert [Sidebar Chat section showing several recent chat sessions with the + new-chat button] here>

<insert [Desktop app with a chat conversation open as a workspace tab, cloud org selected in the org switcher] here>

## Where it lives

- **In the web app** — `/org/{orgId}/chat`. New conversations are private to the user who created them.
- **In the desktop app** — chat opens as a workspace tab once you sign in to Infrawrench Cloud and pick an organization ([desktop vs web](../core-concepts/desktop-vs-web.md)). The conversation history, the agent loop, and billing all live in the cloud, so the same sessions appear on web and desktop. In local-only mode the chat section is hidden.
- **In the sidebar** (web and desktop) — a **Chat** section lists your recent sessions (like Workflows and Dashboards). Click **+** to start a new chat, click a session to reopen it, or hover and click **×** to archive it. Click the section header to see all chats.
- **API** — `POST /api/org/{orgId}/chat/conversations/{id}/messages`. Auth is the same WorkOS session as the rest of the web UI, or an [API key](../team-and-billing/api-keys.md) with the `chat:write` scope.

## What the agent can do

Everything the UI exposes. The chat shares the [MCP server](./mcp.md)'s tool registry:

- **Resource lifecycle** — list, search, get, create, delete, attach, invoke action, apply manifest.
- **SQL** — `sql_query` (read), `sql_execute` (write), `introspect_sql_schema`. Targets either the account's primary database or a per-resource SQL driver (e.g. an individual Neon branch).
- **KV** — `kv_command` for Redis/Memcached/MongoDB-style verbs.
- **Docker** — `docker_command` for container ops on a Docker-enabled account.
- **SSH** — `ssh_exec` for one-shot remote commands. For plugins that natively expose SSH (Fly, Hetzner) the plugin's config is used; otherwise pass an SSH key id and host.
- **Storage** — list / mkdir / delete on cloud buckets (S3, GCS, R2, Azure Blob, Spaces).
- **Secrets** — list / access / add / enable / disable / destroy versions on versioned-secret resources (e.g. GCP Secret Manager).
- **Credentials** — `export_credential` to download IAM access keys, service-account JSON, connection strings, etc.
- **Costs & budgets** — `query_costs` for spend questions ("what did we spend on AWS last month?"), `list_cost_dimension_values`, `get_cost_status`, and budget CRUD (`list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`). These enforce the caller's `costs:read` / `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md). See [Cloud costs](./cloud-costs.md).

## Destructive-action approval

Every tool is tagged with a risk tier: `read`, `write`, or `destructive`. Read and write tools auto-run inside the model loop. Destructive tools (deletes, drops, exec, manifest applies, write SQL, KV writes, Docker stop/restart, secret destroy, credential export) **suspend the loop** and write a pending-action row.

The UI surfaces these as Approve / Reject cards inline in the conversation. Approving runs the tool and resumes the model with the result; rejecting feeds the model an error message it can react to.

API clients see pending actions in the conversation fetch response and POST `{action: "approve" | "reject"}` to `/api/org/{orgId}/chat/conversations/{id}/pending/{pendingId}` to drive the same flow.

<insert [Pending-action card with Approve/Reject buttons and the JSON tool input expanded] here>

## Audit

Every tool the agent executes goes through the same `logAudit` path the UI uses. Resource creations, deletions, manifest applies, SQL writes, KV writes, Docker commands, SSH execs, secret access/modify, and credential exports all show up in the [audit log](../team-and-billing/audit-log.md) with `source: "chat"` (or `source: "api"` if the agent was driven by an API key). Audit rows are attributed to the user behind the session or the user who created the API key — there is no service principal.

## Billing

Chat tokens are billed separately from your seat plan as Stripe metered usage. Pricing tracks Anthropic's published rates per million tokens for the model you choose, with a configurable platform markup (default 1.5×). Cache-read and cache-write tokens are billed at Anthropic's discounted/uplifted rates respectively; the system prompt and the tool registry are aggressively prompt-cached so a long working session typically pays the cache-read rate after the first turn.

### Monthly cap

Each org can set `chatMonthlyCapMicros` (in micro-dollars; 1 USD = 1,000,000). When the org's month-to-date chat cost crosses the cap, the agent refuses to start new turns until the next month or the cap is raised. Set the cap in **Settings → Billing → Chat cap**, or via SQL on the `organizations` row.

The header of every chat shows month-to-date spend and remaining headroom against the cap.

## API surface

Conversation CRUD, the SSE stream, and pending-action approval are all under `/api/org/{orgId}/chat`. See the [API reference](../team-and-billing/openapi.md) once the spec is regenerated for the next release.

```
GET    /conversations               # list
POST   /conversations               # create
GET    /conversations/{id}          # fetch with messages + pending actions
DELETE /conversations/{id}          # archive
POST   /conversations/{id}/messages # SSE stream; body: {text} or {resume: true}
POST   /conversations/{id}/pending/{pendingId}  # body: {action: "approve" | "reject"}
GET    /spend                       # month-to-date + cap
```

`POST /messages` streams Server-Sent Events shaped as `{type: "text_delta" | "tool_use_start" | "tool_use_input" | "tool_executed" | "pending_action" | "turn_end" | "spend_blocked" | "error", ...}`. When the agent suspends on a destructive tool, the stream ends with `turn_end {hasPending: true}` — resume after approving by POSTing `{resume: true}`.

## Why an API and not just MCP?

The [MCP server](./mcp.md) lets you bring your own agent (Claude Desktop, Cursor, your own bot). The hosted chat API is the inverse: Infrawrench provides the agent, you provide the user prompt. It exists so you can:

- Embed the chat in a Slackbot or internal portal without standing up Anthropic billing or rebuilding the tool surface.
- Drive runbooks from CI: "POST a description of what to deploy, get back a streamed plan and approve the destructive steps from a Slack thread."
- Charge the spend back to a single billing surface (your Infrawrench seat plan) rather than splitting Anthropic + infra costs.

Either way the same audit trail, the same approvals, the same plugin tools.
