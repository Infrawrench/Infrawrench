---
title: Fireworks AI
description: Manage Fireworks deployments, models, datasets, fine-tuning and batch jobs, API keys, secrets and quotas — with real usage costs.
sidebar_order: 39
---

Fireworks AI serves open models both serverless and on dedicated GPU capacity you control. This plugin covers the whole control plane, including the one thing most inference providers do not expose: real per-day spend.

## What you can manage

- **Deployments** — dedicated capacity, its replica window, and scaling
- **Models** — base models and LoRA add-ons, with context length and capabilities
- **Deployed models** — LoRA add-ons attached to a deployment
- **Datasets** — uploaded JSONL, with example and token counts
- **Fine-tuning jobs** — supervised runs, with hyperparameters, progress and estimated cost; cancel and resume
- **Batch inference jobs** — progress, success and failure counts, and the output dataset
- **API keys** — full create, with the plaintext shown once
- **Secrets** — the account-scoped secrets jobs reference by key name
- **Quotas** — accelerator quota per region, and how much of it is in use

## Credentials

Two fields, both required.

- **API Key** — create one at [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys). The same key works for inference and for the control plane.
- **Account ID** — your Fireworks account id, e.g. `my-team`.

The account id is required because **Fireworks has no whoami endpoint**. Every control-plane path is `/v1/accounts/{account_id}/…`, so without it nothing lists at all. You can read it off any of your model strings: `accounts/my-team/models/my-model` → `my-team`. It is also shown at the top of app.fireworks.ai.

<insert [The Fireworks AI Add-account form showing the API key and Account ID fields] here>

## Two planes, one key

Fireworks splits its API in a way worth knowing about, because the deployment page shows both:

- **Inference** lives at `https://api.fireworks.ai/inference/v1`, and the account is encoded in the _model string_ (`accounts/my-team/models/llama-3`).
- **Control plane** lives at `https://api.fireworks.ai/v1/accounts/{account_id}/…`, with the account in the _path_.

The same API key authenticates both.

## Costs

Fireworks does report spend, and Infrawrench collects it. Cost rows come from the usage-cost query grouped by day and model, so your Fireworks spend breaks down per model in the normal cost views alongside every other provider.

Two caveats:

- **Account-wide costs need an account-administrator key.** With a plain member key the plugin falls back to that principal's own usage rather than reporting nothing, and says so if even that is refused.
- **Subtotals exclude fixed fees, invoice-level discounts, minimums, credits and taxes.** They are usage priced at your subscription rates, not an invoice.

<insert [The cost view filtered to a Fireworks account, showing daily spend broken down by model] here>

## Metrics

Deployments get a **Metrics** tab charting accelerator-seconds per day. Models chart prompt and completion tokens per day. Both come from the daily billing-usage export, so the window is capped at 31 days.

## Notable flows

- **Scale a deployment** by editing its replica count. Fireworks exposes scaling as a dedicated RPC separate from editing the min/max window, and the plugin sends whichever of the two your edit implies.
- **Create an API key** against any user or service account in the account. The plaintext value is returned exactly once, in the create response, and is shown to you as a warning — Fireworks never stores it, so there is no way to read it back later. Create a replacement instead.
- **Cancel or resume a fine-tuning job** from its detail page.

## Tips & limits

- **Audio inference is gone.** Fireworks removed transcription and text-to-speech from its public API on 10 June 2026 — the documentation 404s and the audio hosts reject requests. This plugin therefore has no [Speech tab](../features/speech-testing.md), and there is no Fireworks path to add one back. Historical audio line items can still appear in billing.
- **Large numbers arrive as strings.** Example counts, token counts and quota values are 64-bit integers that the API returns JSON-encoded as strings. The plugin converts them; if you script against the API yourself, expect strings.
- **Page size caps at 200.** Larger values are silently coerced.
- **API-key listing does not paginate.** Fireworks documents pagination on that route as a TODO, so a very large account may not show every key.
- **Secret values are write-only.** Neither a get nor a list ever returns them, so only the key name is shown.
- **Quotas can be lowered but not raised.** You can set the enforced limit below your approved maximum to cap spend; going above the maximum needs a usage-limit increase request with Fireworks.
