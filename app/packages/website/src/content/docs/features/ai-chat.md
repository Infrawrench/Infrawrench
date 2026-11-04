---
title: AI chat
description: Manage your infrastructure by chatting with an AI agent. It uses the same tools as the UI and asks you to approve anything destructive.
sidebar_order: 12
---

> **Cloud feature**, billed separately from your seat plan. Available in the web app, the [mobile app](./mobile-app.md), and the desktop app when you're signed in to Infrawrench Cloud.

AI chat lets you work on your infrastructure by asking for what you want. You pick the model for each conversation: Google Gemini or Anthropic Claude. The agent can use the same tools you use in the UI. It can list resources, read outputs, run SQL, run Docker commands, rotate secrets, attach disks and apply manifests. Anything destructive waits for you to approve it first.

![Chat page with a streamed assistant reply and a pending-approval card for a delete-resource tool use](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/pending-delete-approval.png)

![Sidebar Chat section showing several recent chat sessions with the + new-chat button](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/sidebar-chat-sessions.png)

<insert [Desktop app with a chat conversation open as a workspace tab, cloud org selected in the org switcher] here>

## Open a chat

- **Web app:** go to `/org/{orgId}/chat`. Each conversation opens in its own workspace tab. A reply keeps streaming while you switch to a dashboard and back. New conversations are private to you.
- **Desktop app:** sign in to Infrawrench Cloud and pick an organization ([desktop vs web](../core-concepts/desktop-vs-web.md)). Chat then opens as a workspace tab. Your conversations and billing live in the cloud, so the same chats show up on web and desktop. In local-only mode, chat is hidden.
- **[Mobile app](./mobile-app.md):** the Chat tab opens the same cloud conversations, with the same model picker, approval cards, question forms and sleep countdowns.
- **Sidebar (web and desktop):** the **Chat** section lists your recent chats. Click **+** to start one, click a chat to reopen it, or hover and click **×** to archive it. Click the section header to see all chats.
- **API:** `POST /api/org/{orgId}/chat/conversations/{id}/messages`. Use your normal web sign-in session, or an [API key](../team-and-billing/api-keys.md) with the `chat:write` scope.

## Who can use it

You need `chat:read` to read conversations and `chat:write` to send messages or approve actions. All three system roles have both. A [custom role](../team-and-billing/roles-and-permissions.md#custom-roles) without `chat:*` blocks chat for the people who hold it.

`chat:write` doesn't give the agent extra power. Every tool it runs is checked against your own permissions first, so it can only do what you could do in the UI. If you ask it to delete a resource and you don't have `resources:delete`, the call is refused. It isn't queued for approval. An API key is narrower still: its scopes are limited by its owner's role, so a key with only `chat:write` can hold a conversation and nothing more.

## What the agent can do

Everything the UI can. Chat uses the same tools as the [MCP server](./mcp.md):

- **Resource lifecycle:** list, search, get, create, delete, attach, run an action, apply a manifest.
- **Sidecars:** work inside the services a managed resource exposes. Ask "what's running in my DOKS cluster?" and the agent finds the cluster's `kubernetes` sidecar (`list_resource_sidecars`) and lists deployments, pods and services through it. The same works for managed databases (`postgres`, `mysql`, `redis`, `mongodb`).
- **SQL:** `sql_query` (read), `sql_execute` (write) and `introspect_sql_schema`. These work on the account's primary database, on a resource's own SQL connection (including REST-queried databases like ClickHouse services and BigQuery datasets), or on a managed database's SQL sidecar (`postgres` or `mysql`) for providers such as Neon, RDS, Cloud SQL and DO managed databases. On PostgreSQL, MySQL and libSQL/Turso, `sql_query` runs one statement in a read-only transaction, so the database itself refuses writes and the query runs without asking you. Input with a `;` anywhere except the end is refused, even inside a string. On engines that can't enforce read-only (SQL Server, PlanetScale, and REST-queried ones such as BigQuery, Databricks, ClickHouse and D1), `sql_query` also shows an approval card.
- **KV:** `kv_command` for Redis, Memcached and MongoDB-style commands.
- **Docker:** `docker_command` for container work on a Docker-enabled account.
- **SSH:** `ssh_exec` for one-off remote commands. For providers with built-in SSH (Fly, Hetzner), the provider's settings are used. Otherwise, pass an SSH key id and host.
- **Storage:** list, create folders and delete in cloud buckets (S3, GCS, R2, Azure Blob, Spaces).
- **Secrets:** list, access, add, enable, disable and destroy versions on versioned secrets (for example GCP Secret Manager).
- **Credentials:** `export_credential` to download IAM access keys, service-account JSON, connection strings and so on.
- **SSH keys:** list, generate (Ed25519), import and delete your org's [SSH keys](../team-and-billing/ssh-keys.md). Generated private keys stay encrypted on the server and are used by id with `ssh_exec`. Deleting a key needs your approval.
- **Workflows:** read, write, type-check and run [workflows](./workflows.md). Ask for "a workflow that scales the dev cluster to zero when the Production budget goes over 90%". The agent reads your org's `infra` typings, writes the code, type-checks it before saving and can run it once to prove it works. Deleting a workflow needs your approval. See [Writing workflows with an AI client](./workflows.md#writing-workflows-with-an-ai-client).
- **Workflow secrets:** list secrets, ask you to set or rotate a value securely, delete secrets and assign them to a workflow. Secret values never enter the conversation or the model's inputs.
- **Deployments:** read your [Infrafile](./infrafile.md) deploy history (`list_deployments`, `get_deployment`), list the repos your GitHub App can deploy from (`list_deployable_repos`), preview a deploy without building (`plan_deployment`) and roll back to a known-good image (`rollback_deployment`). There is **no tool that deploys**. Shipping a release is slow, costly and can't be undone, so you start it yourself from the Deploy tab or the CLI. `plan_deployment` and `rollback_deployment` both need your approval.
- **The web:** `web_search` and `web_fetch`, so the agent can check current docs. Chat only. See [Look things up on the web](#look-things-up-on-the-web).
- **Questions:** `ask_question`, so the agent can stop and ask you to pick from a list or type an answer. Chat only. See [Answer the agent's questions](#answer-the-agents-questions).
- **Costs and budgets:** `query_costs` for spend questions ("what did we spend on AWS last month?"), `list_cost_dimension_values`, `get_cost_status`, and budget tools (`list_budgets`, `get_budget`, `create_budget`, `update_budget`, `delete_budget`). These follow your `costs:read` and `budgets:*` [role permissions](../team-and-billing/roles-and-permissions.md). See [Cloud costs](./cloud-costs.md).
- **Instance pricing:** `get_instance_pricing_schema` and `query_instance_pricing` run read-only SQL over public instance price lists (AWS, Azure, Google Cloud, Alibaba Cloud, RunPod) and their history. No permission is needed, since this isn't your org's data. For your own spend, use `query_costs`. For a quick comparison across more providers without history, use the [price catalog](./price-catalog.md) tools. See [Instance pricing SQL API](../team-and-billing/instance-pricing-api.md).
- **Canvases:** `list_cost_canvases`, `get_cost_canvas`, `run_cost_canvas`, `write_cost_canvas`, `delete_cost_canvas`. Describe a report and the agent builds it as a saved canvas of KPI tiles, charts, tables, budgets, anomalies and notes. It refreshes on its own. A chat started from the Canvases page is tied to that canvas, so "split the table by region" edits it. See [Canvases](./ai-canvas.md).

## Look things up on the web

Two tools let the agent check facts instead of guessing. Like `sleep`, they only exist in chat. The [MCP server](./mcp.md) doesn't offer them, since MCP clients already have their own web access.

- **`web_search`** asks a question and returns a summary with source links. It's for things that change: provider quotas, pricing the instance pricing tools don't cover, changelogs, deprecation notices, an unfamiliar error, the current shape of a third-party API.
- **`web_fetch`** reads one URL as text. HTML comes back as Markdown and JSON is pretty-printed. It's **GET only** and can't submit anything.

Both are read-only, so they usually run without asking you. Ask "is the instance type I'm using still current?" and the agent searches, reads the page and answers with links you can check.

`web_fetch` runs straight away only for a URL you typed into the chat or one that `web_search` returned as a source. Any other URL, such as a link found on a fetched page or one the agent built itself, waits for you on an Approve / Reject card that shows the exact address. A URL can carry data in it, so this stops a hostile log line or resource tag from tricking the agent into sending your data somewhere.

A few limits keep this safe:

- **Only public addresses work.** `web_fetch` refuses private, loopback, link-local and internal addresses, and checks every redirect too. The agent can't be talked into probing your internal network. To reach something private, give it an [SSH](./ssh-terminal.md) route or a workflow.
- **Web pages are data, not instructions.** The agent treats a page that says "run this command" as something to tell you about, not something to do. Every destructive tool still needs your approval, so a hostile page can't get infrastructure deleted unless you click Approve on a card that says so. Read those cards. Other tool results get the same treatment: resource names and tags, log lines, SQL rows and provider error messages are written by whoever controls those systems.
- **Images in replies are never loaded.** An image in a reply shows as a link with its description, and nothing loads until you click it. In the web app, images are also limited to Infrawrench itself and profile-picture hosts.

Searches cost a small amount per query on top of tokens. They show up in your [chat usage](#billing) like any other spend.

If your deployment has no search backend or web proxy set up, the matching tool isn't offered and the agent tells you what it would have looked up. Self-hosters: see `INFRAWRENCH_CHAT_SEARCH_BACKEND` and `WORKFLOW_FETCH_PROXY_URL` in `.env.example`.

![A chat turn where the agent used web_search: the tool card, and the reply below it citing linked sources](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/web-search-turn.png)

## Answer the agent's questions

When the agent needs a decision or a missing detail (which region, which account, a name, a short note), it uses `ask_question`. This is chat only; the [MCP server](./mcp.md) doesn't offer it. Instead of asking in its reply, the agent pauses on a form in the conversation.

Each question is one of:

- **Selection:** a list of options, plus an **Other** field if none fit.
- **Text:** a box for a free-form answer.

One form can mix both. Submit sends all your answers and the chat carries on. This is separate from approval cards. Deletes, exec and other destructive actions still go through Approve / Reject.

![AI chat conversation paused on an ask-question card with a region selection, an Other text field, and a notes textarea](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/ask-question-card.png)

## Approve destructive actions

Every tool has a risk level: `read`, `write` or `destructive`. Read and write tools run on their own. Destructive tools pause the chat until you approve them. These include deletes, drops, exec, manifest applies, write SQL, KV writes, Docker stop and restart, adding or destroying a secret version, credential export, typing or pressing keys in a [Linux application](./linux-apps.md) window, and creating a [sleep/wake schedule](./sleep-schedules.md).

Some tools need approval only for certain inputs, when one argument would let them run code, write data or read a secret:

- `sql_query` runs on its own where the database enforces read-only, and needs approval everywhere else.
- `launch_app` needs approval when given a raw `exec` command instead of an installed app.
- `write_workflow` needs approval when it sets the code, the trigger or the assigned secrets, or enables the workflow. A saved cron workflow runs within the minute, so saving it is as serious as running it. Renaming, changing the description, editing metrics or disabling run on their own.
- `write_custom_graph` needs approval when it sets the code, since a graph script can run SSH commands each time a dashboard shows it.
- `get_resource_outputs` needs approval when it would return a sensitive output (a password, a connection string, a kubeconfig), or when it doesn't name its outputs on a type that has sensitive ones. Non-sensitive outputs like an IP address come back straight away, and `get_resource` leaves sensitive outputs out.
- `web_fetch` needs approval for any URL that didn't come from you or a search. See [Look things up on the web](#look-things-up-on-the-web).
- `write_cost_canvas` needs approval when it replaces a [canvas](./ai-canvas.md) that already has blocks. The card lists what it adds, removes, changes and moves, so you approve the change, not a wall of JSON. Creating a canvas, or filling an empty one, runs straight away.

The [MCP server](./mcp.md) has no approval step. These rules apply to in-app chat.

Approvals show as Approve / Reject cards in the conversation. Approve runs the tool and the agent carries on with the result. Reject tells the agent no, and it can respond to that.

Tool calls show as small status cards that go from `Running…` to `Done`. The input and result sit behind a **Details** toggle on each card. While an action waits for approval, the input is shown so you can see exactly what you're approving. Long inputs such as workflow code, scripts and SQL show as plain text under their field name, so you can read the code first.

## Enter a secret securely

When the agent calls `write_workflow_secret`, the chat pauses on a card. It's headed with the title the agent asked for (or `Enter <secret name>` if it gave none) and shows a description, a **Value required** pill, a password field and a **Store** button. Your value goes straight from your web, desktop or mobile app to encrypted workflow-secret storage. It never appears in your message, the agent's tool input, approval cards, Slack or push notifications, the audit log or anything sent back to the model.

Only a signed-in person with `secrets:write` can submit the field. Your permission is checked when the agent asks and again when you submit, so a role change can't leave behind a prompt with more access than you have. The agent only gets the secret's id or name and `stored: true`. It can then assign that id to a workflow.

![AI chat conversation paused on the secure workflow-secret password field, headed with the requested title and showing the "Value required" pill](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/workflow-secret-prompt.png)

## Wait for slow operations

The agent has a `sleep` tool for waiting on slow work: a database being created, DNS spreading, a reboot. It's chat only; the [MCP server](./mcp.md) doesn't offer it. Instead of a tool card you see a quiet **"Sleeping N seconds…"** countdown, like "Thinking…". When it ends, the chat carries on by itself so the agent can check again. Each sleep is up to 300 seconds, and you can't type while it counts down. Leaving or closing the chat cancels the wait. Reopen it and send a message to continue.

API clients see pending actions when they fetch the conversation. To approve or reject, POST `{action: "approve" | "reject"}` to `/api/org/{orgId}/chat/conversations/{id}/pending/{pendingId}`.

![Pending-action card with Approve/Reject buttons and the JSON tool input expanded](https://agent-assets.infrawrench.com/docs-screenshots/features/ai-chat/pending-action-json.png)

## Audit

Everything the agent does is audited the same way as the UI. Resource creates and deletes, manifest applies, SQL writes, KV writes, Docker commands, SSH execs, secret access and changes, and credential exports all appear in the [audit log](../team-and-billing/audit-log.md) with `source: "chat"`, or `source: "api"` when an API key drove the agent. Each entry is credited to the signed-in user or the user who created the API key. There's no separate service account.

## Choose a model

Pick a model when you start a chat (the picker is next to **New chat**). You can switch an existing chat's model any time from the dropdown in its header. The change applies from the next turn.

| Model                      | Best for                                    |
| -------------------------- | ------------------------------------------- |
| Gemini 3.7 Flash (default) | Most chats: fast, and the cheapest per turn |
| Claude Sonnet 5            | Balanced: near-Opus quality at lower cost   |
| Claude Opus 5              | Complex, multi-step infrastructure work     |
| Claude Haiku 4.5           | Quick lookups                               |

Switching models mid-chat is safe. Your messages, the replies and every tool call and result carry over.

## Billing

Chat is billed as metered usage, separate from your seat plan. You pay exactly **1.5× the model provider's published API rates** per million tokens. There are no other fees.

Caching works differently per provider, and you're only ever charged 1.5× what we're charged:

- **Claude:** long working sessions usually pay the cheaper cache-read rate after the first turn. Cache writes have their own higher rate.
- **Gemini:** caching is automatic. Cached input costs a tenth of the input rate, with no separate cache-write charge. Reasoning tokens cost the output rate.

[Web search](#look-things-up-on-the-web) has one extra charge. Search providers charge per query, not per token, so a `web_search` call costs 1.5× the provider's per-query rate (currently $0.021 per query on Google Search grounding and $0.015 on Anthropic web search), plus 1.5× the tokens of the small model that runs the search. One call can run more than one query when needed, and you pay for the queries actually run. `web_fetch` has no per-request fee. You only pay for the page text that enters the chat as tokens.

One pool covers every AI feature. [`infra.ai(...)` calls from workflows](./workflows.md#asking-a-model-for-help) cost the same and count toward the same monthly spend and caps below.

### Free tier

Orgs on the free plan get **$5 of AI usage per month**, shared between chat and workflow `infra.ai` calls. When it runs out, the agent won't start new turns (and `infra.ai` throws an error) until next month. Add a payment method in **Settings > Billing** to keep going. While the free cap applies, the chat header shows `(free tier)` next to your spend.

Any paid seat lifts the cap: a monthly subscription or a [prepaid capacity slot](../team-and-billing/billing-and-plans.md#prepaid-capacity-slots).

### Set a monthly cap

You can set a monthly cap for your org (`chatMonthlyCapMicros`, in micro-dollars: 1 USD = 1,000,000). Once your month-to-date AI spend (chat plus workflow `infra.ai` calls) passes the cap, the agent won't start new turns and `infra.ai` throws an error until next month or until you raise the cap. Several chats and workflows running at once can't push spend past it. Set the cap in **Settings > Billing > Chat cap**. On the free tier, a cap below $5 still applies. Caps above $5 apply once you're on a paid plan.

Every chat header shows your month-to-date spend and how much is left under the cap.

## API

Conversations, the event stream and approvals all live under `/api/org/{orgId}/chat`. See the [API reference](../team-and-billing/openapi.md) once the spec is regenerated for the next release.

```
GET    /conversations               # list
POST   /conversations               # create
PATCH  /conversations/{id}          # change settings; body: {model}
GET    /conversations/{id}          # fetch with messages + pending actions
DELETE /conversations/{id}          # archive
POST   /conversations/{id}/messages # SSE stream; body: {text} or {resume: true}
POST   /conversations/{id}/pending/{pendingId}  # body: {action: "approve" | "reject"}
POST   /conversations/{id}/pending/{pendingId}/answer  # body: {answers}; ask_question only
POST   /conversations/{id}/secret-requests/{requestId} # body: {value}; human-only, write-only
GET    /spend                       # month-to-date + cap
```

`POST /messages` streams Server-Sent Events shaped as `{type: "text_delta" | "tool_use_start" | "tool_use_input" | "tool_executed" | "pending_action" | "secret_request" | "sleep" | "turn_end" | "spend_blocked" | "error", ...}`. When the agent pauses on a destructive tool, a question or a secret request, the stream ends with `turn_end {hasPending: true}`. Resolve every pending item, then POST `{resume: true}` to carry on.

## Why use the chat API instead of MCP?

The [MCP server](./mcp.md) lets you bring your own agent (Claude Desktop, Cursor, your own bot). The chat API is the other way round: Infrawrench provides the agent and you provide the prompt. Use it to:

- Put the chat in a Slackbot or internal portal without setting up your own Anthropic billing or tools.
- Run runbooks from CI: "POST a description of what to deploy, get back a streamed plan and approve the destructive steps from a Slack thread."
- Keep AI spend on one bill (your Infrawrench plan) instead of splitting it between Anthropic and Infrawrench.

Either way you get the same audit trail, the same approvals and the same tools.
