---
title: Cloudflare
description: Manage zones, DNS, Workers, R2, Pages, KV, D1, Tunnels, Access, and more.
sidebar_order: 20
---

The Cloudflare plugin is broad — 24 resource types across DNS, edge compute, storage, AI, and zero-trust.

## What you can manage

- **DNS & zones** — zones, DNS records (with proxy status toggle), email routing.
- **Edge compute** — Workers (with script editor), Pages, Workers KV, D1 (SQLite), Hyperdrive.
- **Workers AI** — the text-generation model catalog, each with a chat Playground.
- **Storage** — R2 buckets (with the [file browser](../features/file-browsers.md)).
- **Zero Trust** — Access applications, Tunnels.
- **Zone settings** — cache, security, SSL, performance toggles, edited via the [manifest editor](../features/manifest-editor.md).

## Credentials

The API token field in the **Add account** and **Update credentials** forms shows a **“Create a token with these scopes”** link. Click it to open Cloudflare's token creator with the scopes this plugin uses already selected — review them, create the token, and paste it back into the field. (Cloudflare only ever shows the token value once, at creation time.)

If you'd rather scope a token by hand, go to the Cloudflare dashboard → **My Profile → API Tokens → Create Token** and grant the permissions matching the resources you plan to manage.

<insert [Cloudflare Add-account form with the API token field and the "Create a token with these scopes" link highlighted] here>

## Notable flows

- **DNS records table** — a zone's records render as a Cloudflare-style table (type, name, content, proxy, TTL) with inline create and delete. See [DNS records](../features/dns-records.md).
- **DNS record editor** with type-aware fields (A, AAAA, CNAME, MX, TXT, SRV, CAA). A/AAAA/CNAME values can be [pointed at another resource](../features/dns-records.md) (e.g. an AWS Elastic IP) and tracked live.
- **Worker script editing** in Monaco with deploy.
- **R2 file browser** and **secret export to K8s** for bucket credentials.
- **KV namespace browser** — open any Workers KV namespace and use the **Keys** tab to list keys (cursor-paginated, with optional prefix filter), view stored values, add or overwrite a key, and delete keys. Backed by Cloudflare's `/storage/kv/namespaces/{id}/keys` and `/values/{key}` REST endpoints. Values are treated as UTF-8 text.
- **D1 SQL editor** — open any D1 database and use the **SQL Editor** tab to run queries. The default query lists tables via `sqlite_master`.
- **Zone setting patches** — field-by-field, partial failures reported individually.

<insert [Cloudflare KV namespace detail page with the Keys tab open, showing a list of keys with the value of a selected key displayed] here>

- **Workers AI Playground** — open any model under **Workers AI Models** and use the **Playground** tab to chat with it. Responses stream token-by-token through Cloudflare's OpenAI-compatible chat endpoint (`/ai/v1/chat/completions`), authorized with the account's API token. The whole conversation history is sent on each turn, and per-turn token usage is shown under each assistant reply when Cloudflare returns it. The token needs the **Workers AI:Read** permission to list models and run completions.

<insert [Cloudflare Workers AI model detail page with the Playground tab open, showing a streamed assistant reply] here>

- **Queue detail page** — opens with the queue's settings (delivery delay, retention period, pause state) inline, a **Consumers** tab listing every bound Worker or pull consumer with its batch size, retry policy, and dead-letter queue, and a **Publish** tab for pushing a one-off test message into the queue. Backed by the Cloudflare Queues HTTP API (`GET /queues/{id}`, `GET /queues/{id}/consumers`, `POST /queues/{id}/messages`). The token needs the **Queues:Edit** permission to publish.

<insert [Cloudflare Queue detail page with the Consumers tab open, showing a table of Worker consumers and their retry settings] here>

## Metrics

The detail page surfaces a **Metrics** tab whenever Cloudflare's GraphQL Analytics API exposes useful time-series data for a resource. The plugin pulls from the relevant adaptive-groups datasets so you can see traffic and health without leaving Infrawrench:

- **Zone** — requests, bandwidth, cached requests, threats, unique visitors (`httpRequests1mGroups` / `httpRequests1hGroups`).
- **Worker** — invocations, errors, subrequests, CPU time p50/p99 (`workersInvocationsAdaptiveGroups`).
- **R2 bucket** — Class A and Class B operations, object count, stored bytes (`r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`).
- **Pages project** — function invocations, errors, CPU time p99 (`pagesFunctionInvocationsAdaptiveGroups`).
- **Spectrum application** — events, ingress/egress bytes, connections (`spectrumNetworkAnalyticsAdaptiveGroups`).
- **D1 database** — read/write queries, rows read/written, response bytes, query batch latency p90 (`d1AnalyticsAdaptiveGroups`, daily granularity).
- **KV namespace** — reads, writes, deletes, lists, key count and stored bytes (`kvOperationsAdaptiveGroups`, `kvStorageAdaptiveGroups`, daily granularity).
- **Queue** — messages produced, consumed, acknowledged, retried, bytes transferred, backlog (`queueMessageOperationsAdaptiveGroups`, `queuesBacklogAdaptiveGroups`).
- **Hyperdrive** — total queries, cache hits/misses, errors, query and result bytes, query and connection latency (`hyperdriveQueriesAdaptiveGroups`).
- **Load balancer** — total request count and per-pool breakdown (`loadBalancingRequestsAdaptiveGroups`).
- **Waiting room** — active users, queued users, new users/minute, time-on-origin p50, time-waited p90 (`waitingRoomAnalyticsAdaptiveGroups`).

The token needs the **Account Analytics:Read** permission for account-scoped datasets and **Zone Analytics:Read** for zone-scoped ones — the "Create a token with these scopes" link includes both. Resources with no traffic in the selected window show an empty Metrics tab, which is expected.

## Tips & limits

- Cloudflare’s API returns paginated lists; very large zones (1000s of records) load in chunks.
- Tokens can be scoped to specific zones. If you only see some zones, check the token scope.
- GraphQL Analytics datasets retain the last 31 days of data; older ranges return no points.
