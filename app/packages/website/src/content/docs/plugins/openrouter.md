---
title: OpenRouter
description: Browse the OpenRouter catalogue with per-provider pricing, uptime and latency percentiles, manage API keys and credits, and run speech synthesis and transcription from the Speech tab.
sidebar_order: 36
---

## What you can manage

- **Models** — the full catalogue across every modality, with per-million-token pricing, context length, tokenizer and knowledge cutoff.
- **Model endpoints** — the thing that is genuinely unique to OpenRouter: each provider's own serving endpoint for a model, with its own price, uptime over 5 minutes / 30 minutes / 1 day, latency p50–p99 and throughput. This is how you tell whether "GPT-4 on OpenRouter" is the cheap slow one or the fast expensive one today.
- **Providers** — every upstream OpenRouter routes to, with headquarters and datacenter regions for data-residency checks.
- **API keys** — full CRUD, including per-key credit limits, reset interval (daily/weekly/monthly), expiry, and whether BYOK usage counts against the limit.

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

## Costs and metrics

Spend comes from `GET /activity`, broken down by day, model and upstream provider, so the cost page attributes spend to the provider that actually served the request. Each model's **Metrics** tab charts its daily spend and request count.

Remaining account credit is read from `GET /credits` and shown on API key cards.

## Tips & limits

- **`/activity` only covers the last 30 completed UTC days.** There is no deeper history to backfill, so the cost chart starts 30 days ago and no earlier.
- **Pagination is `offset` + `limit`, not a cursor.** The model list is fetched 1,000 at a time — OpenRouter's maximum.
- **`GET /models` defaults to text-only.** Image, speech, transcription and embedding models only appear when you ask for every modality, which the plugin does. Dedicated audio models report `speech` and `transcription` as their output modality, not `audio` — `audio` is reserved for omni chat models.
- **Prices arrive as decimal strings in USD per token.** The app normalizes everything to dollars per million tokens so models are comparable without mental arithmetic.
- **Uploads are capped at 25 MB.**
- **The plaintext of a new API key is shown once.** `POST /keys` is the only response that ever contains it; OpenRouter cannot return it again.
- **Mid-stream errors are not HTTP errors.** Once a streamed response emits its first token the `200` is already committed, so a failure arrives as an SSE event with `finish_reason: "error"` rather than a status code. Nothing in this plugin streams, but it is worth knowing if you are debugging your own OpenRouter integration alongside it.
