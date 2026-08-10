---
title: AI chat
description: Drive your infrastructure through an AI agent — same tools as the UI, with a human-in-the-loop for destructive actions.
sidebar_order: 12
---

> **Cloud feature**; metered separately from your seat plan. Available in the web app, the [mobile app](./mobile-app.md), and — when signed in to Infrawrench Cloud — in the desktop app, where it proxies through the web backend.

Infrawrench ships an in-app **AI chat**, running on Google Gemini or Anthropic Claude — your pick per conversation. The model has access to the same tools your UI uses — listing resources, inspecting outputs, running SQL queries, executing Docker commands, rotating secrets, attaching disks, applying manifests — and routes every destructive action through a UI approval step.

<insert [Chat page with a streamed assistant reply and a pending-approval card for a delete-resource tool use] here>

<insert [Sidebar Chat section showing several recent chat sessions with the + new-chat button] here>

<insert [Desktop app with a chat conversation open as a workspace tab, cloud org selected in the org switcher] here>

## Where it lives

- **In the web app** — `/org/{orgId}/chat`. Each conversation opens as its own workspace tab, so the tab bar and browser tab title follow the chat you are in, and a streaming reply keeps running while you switch to a dashboard and back. New conversations are private to the user who created them.
- **In the desktop app** — chat opens as a workspace tab once you sign in to Infrawrench Cloud and pick an organization ([desktop vs web](../core-concepts/desktop-vs-web.md)). The conversation history, the agent loop, and billing all live in the cloud, so the same sessions appear on web and desktop. In local-only mode the chat section is hidden.
- **In the [mobile app](./mobile-app.md)** — the Chat tab talks to the same cloud conversations, with the same model picker, approval cards, and sleep countdowns as web and desktop.
- **In the sidebar** (web and desktop) — a **Chat** section lists your recent sessions (like Workflows and Dashboards). Click **+** to start a new chat, click a session to reopen it, or hover and click **×** to archive it. Click the section header to see all chats.
- **API** — `POST /api/org/{orgId}/chat/conversations/{id}/messages`. Auth is the same WorkOS session as the rest of the web UI, or an [API key](../team-and-billing/api-keys.md) with the `chat:write` scope.

## Who can use it

Chat requires the `chat:read` permission to read conversations and `chat:write` to send messages or approve an action. All three system roles have both, so this changes nothing by default — but a [custom role](../team-and-billing/roles-and-permissions.md#custom-roles) that omits `chat:*` now blocks chat for the people assigned to it.

Holding `chat:write` does not widen what chat can do. Every tool the assistant runs is checked against the caller's own permissions first, so the assistant can only do what that person could do through the UI. Ask it to delete a resource without `resources:delete` and the tool call is refused, not queued for approval. An API key is narrower still: its scopes are intersected with its owner's role, so a `chat:write`-only key can hold a conversation and nothing more.

## What the agent can do

Everything the UI exposes. The chat shares the [MCP server](./mcp.md)'s tool registry:

- **Resource lifecycle** — list, search, get, create, delete, attach, invoke action, apply manifest.
- **Sidecars** — operate inside the peer plugins managed resources expose: ask "what's running in my DOKS cluster?" and the agent discovers the cluster's `kubernetes` sidecar (`list_resource_sidecars`) and lists deployments/pods/services through it; same for managed databases (`postgres`/`mysql`/`redis`/`mongodb`).
- **SQL** — `sql_query` (read), `sql_execute` (write), `introspect_sql_schema`. Targets the account's primary database, a per-resource SQL driver (including REST-queried databases like ClickHouse services and BigQuery datasets), or — for managed-database providers whose own plugin has no SQL driver (Neon, RDS, Cloud SQL, DO managed databases, …) — the database's SQL sidecar (`postgres`/`mysql`), the same way the sidecar tools above do.
- **KV** — `kv_command` for Redis/Memcached/MongoDB-style verbs.
- **Docker** — `docker_command` for container ops on a Docker-enabled account.
- **SSH** — `ssh_exec` for one-shot remote commands. For plugins that natively expose SSH (Fly, Hetzner) the plugin's config is used; otherwise pass an SSH key id and host.
- **Storage** — list / mkdir / delete on cloud buckets (S3, GCS, R2, Azure Blob, Spaces).
- **Secrets** — list / access / add / enable / disable / destroy versions on versioned-secret resources (e.g. GCP Secret Manager).
- **Credentials** — `export_credential` to download IAM access keys, service-account JSON, connection strings, etc.
- **SSH keys** — list, generate (Ed25519), import, and delete the org's [SSH keys](../team-and-billing/ssh-keys.md). Generated private keys stay encrypted server-side and are used by id with `ssh_exec`; deletion goes through the approval flow.
- **Workflows** — read, write, type-check, and run [workflows](./workflows.md). Ask for "a workflow that scales the dev cluster to zero when the Production budget goes over 90%" and the agent fetches your org's generated `infra` typings, writes the source against them, type-checks it before saving, and can run it once to prove it works. Deleting a workflow goes through the approval flow. See [Writing workflows with an AI client](./workflows.md#writing-workflows-with-an-ai-client).
- **Deployments** — read your [Infrafile](./infrafile.md) deploy history (`list_deployments`, `get_deployment`), list the repos your GitHub App can deploy from (`list_deployable_repos`), preview a deploy without building anything (`plan_deployment`), and put a known-good image back (`rollback_deployment`). There is deliberately **no tool that deploys** — building and shipping a release is slow, expensive, and irreversible, so a human starts it from the Deploy tab or the CLI. Both `plan_deployment` and `rollback_deployment` go through the approval flow.
- **The web** — `web_search` and `web_fetch`, so the agent can check current documentation instead of relying on training data. Chat-only; see [Reading the web](#reading-the-web).
- **Costs & budgets** — `query_costs` for spend questions ("what did we spend on AWS last month?"), `list_cost_dimension_values`, `get_cost_status`, and budget CRUD (`list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`). These enforce the caller's `costs:read` / `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md). See [Cloud costs](./cloud-costs.md).

## Reading the web

Two tools let the agent look things up instead of guessing from training data. Like `sleep`, they are chat-only — the [MCP server](./mcp.md) does not expose them, because an MCP client already runs inside a host with its own web access.

- **`web_search`** — asks a question and gets back a summary with source links. Use it for anything that changes: current provider pricing and quotas, a changelog or deprecation notice, an unfamiliar error string, the present shape of a third-party API.
- **`web_fetch`** — reads one URL as text. HTML is converted to Markdown and JSON is pretty-printed. It is **GET only** and cannot submit anything.

Both are `read`-tier, so they run without an approval prompt. Ask "is the instance type I'm using still current?" and the agent searches, reads the page it finds, and answers with links you can check.

Two limits are deliberate:

- **Only public addresses are reachable.** `web_fetch` goes out through an egress proxy that runs outside the cluster and refuses private, loopback, link-local and cluster-internal addresses, re-checking every redirect hop. The agent cannot be talked into probing your internal network with it. To reach something private, give it an [SSH](./ssh-terminal.md) route or a workflow instead.
- **Fetched pages are data, never instructions.** Web content arrives fenced and labelled as untrusted, and the agent is told to treat a page that says "run this command" as something to report to you rather than obey. Combined with the approval prompt on every destructive tool, that means a hostile page cannot get infrastructure deleted without you clicking Approve on a card that says so. Read those cards.

Searches cost a small amount per query on top of tokens, and show up in your [chat usage](#billing) like any other spend.

If the deployment has no search backend or no egress proxy configured, the matching tool simply isn't offered and the agent will tell you what it would have looked up. Self-hosters: see `INFRAWRENCH_CHAT_SEARCH_BACKEND` and `WORKFLOW_FETCH_PROXY_URL` in `.env.example`.

<insert [A chat turn where the agent used web_search: the tool card, and the reply below it citing linked sources] here>

## Destructive-action approval

Every tool is tagged with a risk tier: `read`, `write`, or `destructive`. Read and write tools auto-run inside the model loop. Destructive tools (deletes, drops, exec, manifest applies, write SQL, KV writes, Docker stop/restart, secret destroy, credential export) **suspend the loop** and write a pending-action row.

The UI surfaces these as Approve / Reject cards inline in the conversation. Approving runs the tool and resumes the model with the result; rejecting feeds the model an error message it can react to.

Tool calls render as compact status cards (`Running…` → `Done`); the input JSON and the tool's result sit behind a collapsed **Details** toggle on each card, except while an action is pending approval, when the input is shown so you can see exactly what you're approving.

## Waiting on slow operations

The chat agent has a `sleep` tool (chat-only — the [MCP server](./mcp.md) does not expose it) for waiting out slow operations: provisioning a database, DNS propagation, a reboot. Instead of a tool card the UI shows a quiet **"Sleeping N seconds…"** countdown (like "Thinking…"); the wait runs in your client, and when it finishes the conversation automatically resumes so the agent can re-check. Up to 300 seconds per call; the composer is disabled while a sleep is counting down. Leaving or closing the chat cancels the wait — reopen it and send a message to continue.

API clients see pending actions in the conversation fetch response and POST `{action: "approve" | "reject"}` to `/api/org/{orgId}/chat/conversations/{id}/pending/{pendingId}` to drive the same flow.

<insert [Pending-action card with Approve/Reject buttons and the JSON tool input expanded] here>

## Audit

Every tool the agent executes goes through the same `logAudit` path the UI uses. Resource creations, deletions, manifest applies, SQL writes, KV writes, Docker commands, SSH execs, secret access/modify, and credential exports all show up in the [audit log](../team-and-billing/audit-log.md) with `source: "chat"` (or `source: "api"` if the agent was driven by an API key). Audit rows are attributed to the user behind the session or the user who created the API key — there is no service principal.

## Models

Pick the model when you start a chat (the picker sits next to **New chat**), or switch an existing conversation's model at any time from the dropdown in the conversation header — the change takes effect on the next turn.

| Model                      | Best for                                     |
| -------------------------- | -------------------------------------------- |
| Gemini 3.6 Flash (default) | Most chats — fast, and the cheapest per turn |
| Claude Sonnet 5            | Balanced — near-Opus quality at lower cost   |
| Claude Opus 5              | Complex, multi-step infrastructure work      |
| Claude Haiku 4.5           | Quick lookups                                |

Switching models mid-conversation is safe: each model's private reasoning traces stay with the model that produced them, and the visible transcript — your messages, its replies, every tool call and result — carries over intact.

## Billing

Chat tokens are billed separately from your seat plan as Stripe metered usage. The charge is exactly **1.5× the model provider's published per-model API rates** per million tokens — no other fees.

Caching behaves differently per provider, and you're only ever charged 1.5× what we're charged:

- **Claude** — the system prompt and the tool registry are aggressively prompt-cached, so a long working session typically pays the discounted cache-read rate after the first turn. Cache writes carry their own uplifted rate.
- **Gemini** — caching is implicit and automatic. Cached input bills at a tenth of the input rate and there is no separate cache-write charge. Reasoning tokens bill at the output rate.

[Web search](#reading-the-web) has one extra component. Search providers charge per query rather than per token, so a `web_search` call bills 1.5× the provider's per-query rate — currently $0.021 per query on Google Search grounding, $0.015 on Anthropic web search — plus 1.5× the tokens of the small model that runs the retrieval. One call can issue more than one query when the question needs it, and you're charged for the queries actually run. `web_fetch` has no per-request fee; you pay only for the page text that enters the conversation as tokens.

One pool covers every AI feature: [`infra.ai(...)` calls made from workflows](./workflows.md#asking-a-model-for-help) are metered at the same rates and count toward the same month-to-date spend and caps described below.

### Free tier

Orgs on the free plan get **$5 of AI usage per month**, shared between chat and workflow `infra.ai` calls. When that runs out, the agent refuses new turns (and `infra.ai` throws) until the next month — add a payment method in **Settings → Billing** to keep going. The chat header shows `(free tier)` next to the spend readout while the free cap applies.

Either kind of paid seat lifts the cap: a monthly subscription or a [prepaid capacity slot](../team-and-billing/billing-and-plans.md#prepaid-capacity-slots).

### Monthly cap

Each org can set `chatMonthlyCapMicros` (in micro-dollars; 1 USD = 1,000,000). When the org's month-to-date AI cost — chat plus workflow `infra.ai` calls — crosses the cap, the agent refuses to start new turns and `infra.ai` throws, until the next month or the cap is raised. Chat and workflow calls share one reservation lock before each model request so concurrent consumers cannot race past the line; in-flight holds are refreshed while a call runs and expire within minutes if a process dies mid-call. Set the cap in **Settings → Billing → Chat cap**, or via SQL on the `organizations` row. On the free tier, a configured cap below $5 still applies; caps above $5 take effect once the org is on a paid plan.

The header of every chat shows month-to-date spend and remaining headroom against the cap.

## API surface

Conversation CRUD, the SSE stream, and pending-action approval are all under `/api/org/{orgId}/chat`. See the [API reference](../team-and-billing/openapi.md) once the spec is regenerated for the next release.

```
GET    /conversations               # list
POST   /conversations               # create
PATCH  /conversations/{id}          # change settings; body: {model}
GET    /conversations/{id}          # fetch with messages + pending actions
DELETE /conversations/{id}          # archive
POST   /conversations/{id}/messages # SSE stream; body: {text} or {resume: true}
POST   /conversations/{id}/pending/{pendingId}  # body: {action: "approve" | "reject"}
GET    /spend                       # month-to-date + cap
```

`POST /messages` streams Server-Sent Events shaped as `{type: "text_delta" | "tool_use_start" | "tool_use_input" | "tool_executed" | "pending_action" | "sleep" | "turn_end" | "spend_blocked" | "error", ...}`. When the agent suspends on a destructive tool, the stream ends with `turn_end {hasPending: true}` — resume after approving by POSTing `{resume: true}`.

## Why an API and not just MCP?

The [MCP server](./mcp.md) lets you bring your own agent (Claude Desktop, Cursor, your own bot). The hosted chat API is the inverse: Infrawrench provides the agent, you provide the user prompt. It exists so you can:

- Embed the chat in a Slackbot or internal portal without standing up Anthropic billing or rebuilding the tool surface.
- Drive runbooks from CI: "POST a description of what to deploy, get back a streamed plan and approve the destructive steps from a Slack thread."
- Charge the spend back to a single billing surface (your Infrawrench seat plan) rather than splitting Anthropic + infra costs.

Either way the same audit trail, the same approvals, the same plugin tools.
