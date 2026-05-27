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

- **DNS record editor** with type-aware fields (A, AAAA, CNAME, MX, TXT, SRV, CAA).
- **Worker script editing** in Monaco with deploy.
- **R2 file browser** and **secret export to K8s** for bucket credentials.
- **Zone setting patches** — field-by-field, partial failures reported individually.
- **Workers AI Playground** — open any model under **Workers AI Models** and use the **Playground** tab to chat with it. Responses stream token-by-token through Cloudflare's OpenAI-compatible chat endpoint (`/ai/v1/chat/completions`), authorized with the account's API token. The whole conversation history is sent on each turn, and per-turn token usage is shown under each assistant reply when Cloudflare returns it. The token needs the **Workers AI:Read** permission to list models and run completions.

<insert [Cloudflare Workers AI model detail page with the Playground tab open, showing a streamed assistant reply] here>

## Tips & limits

- Cloudflare’s API returns paginated lists; very large zones (1000s of records) load in chunks.
- Tokens can be scoped to specific zones. If you only see some zones, check the token scope.
