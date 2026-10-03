---
title: OpenRouter
description: Browse the OpenRouter catalogue with per-provider pricing, uptime and latency percentiles, manage API keys, guardrails, workspaces, budgets, BYOK credentials and credits, and run speech synthesis and transcription from the Speech tab.
sidebar_order: 36
---

## What you can manage

- **Models** — the full catalogue across every modality, with per-million-token pricing, context length, tokenizer and knowledge cutoff.
- **Model endpoints** — the thing that is genuinely unique to OpenRouter: each provider's own serving endpoint for a model, with its own price, uptime over 5 minutes / 30 minutes / 1 day, latency p50–p99 and throughput. This is how you tell whether "GPT-4 on OpenRouter" is the cheap slow one or the fast expensive one today.
- **Providers** — every upstream OpenRouter routes to, with headquarters and datacenter regions for data-residency checks.
- **API keys**: full CRUD, including per-key credit limits, reset interval (daily/weekly/monthly), expiry, whether BYOK usage counts against the limit, the workspace the key belongs to, and a Metrics tab of its requests, spend, tokens and latency.
- **Guardrails**: spend limits and routing policy (allowed and blocked providers and models, data regions, zero data retention, training opt-ins), with the API keys they apply to. Full CRUD.
- **Workspaces**: default models and provider sort, observability logging settings, daily, weekly, monthly and lifetime budgets, member count, and a Metrics tab. Full CRUD.
- **BYOK credentials**: your own keys for upstream providers, with fallback and BYOK-only routing. Create, edit and delete.

## Credentials

OpenRouter needs **two keys**, because neither one can do the other's job.

**Management Key** (required) — [openrouter.ai/settings/management-keys](https://openrouter.ai/settings/management-keys). This is what OpenRouter used to call a _provisioning key_; the schema still carries both names. It is the only credential `/credits`, `/activity` and `/keys` accept — a plain inference key gets a `403` from all of them, which is very nearly the whole console surface. This is the key the plugin lists resources with.

**Inference API Key** (optional) — [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). A normal `sk-or-v1-…` key. Management keys are explicitly rejected by the completion endpoints, so the **Speech tab** needs one of these. Without it every list still works and the Speech tab renders with an explanation instead of failing.

![OpenRouter Add-account form showing the required Management Key field and the optional Inference API Key field, with the description explaining why both exist](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openrouter/add-account.png)

## Comparing providers for a model

Open any model and scroll to **Provider endpoints**. Every provider serving that model is listed with its prompt and completion price per million tokens, context window, 1-day uptime, p50 and p99 latency, and p50 throughput — the whole routing decision on one line each.

![OpenRouter model detail page with the Provider endpoints table showing several providers, their prices, uptime and latency percentiles side by side](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openrouter/provider-endpoints.png)

The top-level **Model Endpoints** list is capped to the most popular models, because listing endpoints for the entire catalogue would be one API call per model. A model's own page always shows all of its endpoints regardless.

## The Speech tab

Models that produce **speech** or **transcription** get a **Speech** tab.

- **Synthesize** posts to `POST /audio/speech` and asks for MP3. The model picker is populated live from `GET /models?output_modalities=speech`, and the voice picker from each model's own `supported_voices` — so the voices for the model you are looking at come first, and every entry says which model it belongs to.
- **Transcribe** posts to `POST /audio/transcriptions`. The endpoint takes either a multipart upload or a JSON body with base64 audio; the plugin uses the JSON form, because your clip already arrives base64-encoded from the browser and re-encoding it would be pure waste.

Both halves share one model picker. If you leave it on a transcription model and press Synthesize, the plugin quietly falls back to a valid speech model rather than sending a request OpenRouter will reject.

## Guardrails, workspaces and BYOK

All three need the management key.

**Create a guardrail** with pickers for everything it references: allowed and blocked providers come from the live provider list, allowed and blocked models from the full model catalogue, and **Apply to API keys** from your keys. The plugin creates the guardrail and then assigns the picked keys in a second call. The detail page shows the budget, the routing policy, any built-in content filters (email, phone numbers, secrets and so on) and the assigned keys.

Editing a guardrail changes its limit, reset interval, flags and policy lists. The lists are edited as comma-separated provider slugs or model ids, exactly as the detail page shows them; key assignments are made at creation or in the OpenRouter dashboard.

<insert [OpenRouter Create Guardrail form with the allowed providers multi-select open and two API keys ticked under Apply to API keys] here>

**Workspaces** carry their own budgets, one per interval. Edit the **Daily**, **Weekly**, **Monthly** or **Lifetime Budget** field to set it; clear it (or set it to 0) to remove that budget. **BYOK Counts Toward Budgets** travels with the budget update, which is the only place OpenRouter accepts it for a workspace. Deleting the default workspace is refused; OpenRouter requires an explicit confirmation the plugin never sends.

**BYOK credentials** are created from a provider picker and the provider's own key, which OpenRouter stores encrypted and never returns: only its masked label is shown. You can toggle fallback to OpenRouter credits, BYOK-only routing and the allowed models later.

## Costs and metrics

Spend comes from `GET /activity`, broken down by day, model and upstream provider, so the cost page attributes spend to the provider that actually served the request.

Models, API keys and workspaces each get a **Metrics** tab, read from OpenRouter's Analytics API (`POST /analytics/query`, the same data as the Activity dashboard) and filtered to that model, key or workspace:

- requests, spend and BYOK spend
- prompt, completion and reasoning tokens
- prompt cache hit rate
- provider time to first token at p50 and p90, and throughput (completion tokens per second) at p50

Buckets are per minute for ranges up to six hours, hourly up to a week, and daily beyond that. OpenRouter only computes the latency and throughput percentiles for ranges up to 31 days, so wider ranges chart the usage series alone. A model is matched on both its catalogue id and its canonical slug, because analytics records requests under the dated permaslug. If the Analytics API refuses the key, a model's tab falls back to the daily spend, requests and tokens from `GET /activity`.

<insert [OpenRouter API key Metrics tab showing requests, spend and time to first token over the last 30 days] here>

Remaining account credit is read from `GET /credits` and shown on API key cards.

## Tips & limits

- **`/activity` only covers the last 30 completed UTC days.** There is no deeper history to backfill, so the cost chart starts 30 days ago and no earlier.
- **Pagination is `offset` + `limit`, not a cursor.** The model list is fetched 1,000 at a time — OpenRouter's maximum.
- **`GET /models` defaults to text-only.** Image, speech, transcription and embedding models only appear when you ask for every modality, which the plugin does. Dedicated audio models report `speech` and `transcription` as their output modality, not `audio` — `audio` is reserved for omni chat models.
- **Prices arrive as decimal strings in USD per token.** The app normalizes everything to dollars per million tokens so models are comparable without mental arithmetic.
- **Uploads are capped at 25 MB.**
- **The plaintext of a new API key is shown once.** `POST /keys` is the only response that ever contains it; OpenRouter cannot return it again.
- **Mid-stream errors are not HTTP errors.** Once a streamed response emits its first token the `200` is already committed, so a failure arrives as an SSE event with `finish_reason: "error"` rather than a status code. Nothing in this plugin streams, but it is worth knowing if you are debugging your own OpenRouter integration alongside it.
