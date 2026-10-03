---
title: Together AI
description: Dedicated endpoints, fine-tunes, files, batches, evaluations and GPU clusters on Together AI, with spend from the billing usage API and a Speech tab for text-to-speech and Whisper transcription.
sidebar_order: 37
---

Together AI runs open models as serverless inference, as dedicated GPU endpoints you reserve, and as batch and fine-tuning jobs. This plugin covers all of it from one account.

## What you can manage

- **Dedicated endpoints** — create, start, stop, rescale and delete a model pinned to reserved GPU hardware
- **Managed endpoints**: the newer Dedicated Managed Inference (v2) endpoints, with their deployments, the last 24 hours of traffic, latency, utilization and token totals, and a Metrics tab
- **Models** — the serverless catalogue, with context length and Together's list pricing
- **Fine-tunes**: job status, hyperparameters, tokens processed, the model each one produced, its checkpoints and its event log
- **Files** — uploaded JSONL datasets, with line counts and validation errors
- **Batch jobs** — create one from an uploaded file, watch progress, cancel it
- **Evaluations** — classify, score and compare runs
- **Hardware** — the GPU configurations a dedicated endpoint can run on, with pricing
- **GPU clusters**: create, resize, change type and delete Kubernetes or Slurm Instant Clusters, with their worker nodes, attached volumes and a Kubernetes tab
- **Shared volumes**: create, grow and delete the regional storage GPU clusters mount

## Credentials

Together AI has a single key type. Create one at [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys) and paste it as **API Key**.

There is no second admin key to add, and you do not need to supply a project id — the plugin reads it from `GET /v1/whoami`, which is also how it validates the key when you add the account.

![The Together AI Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/together/add-account.png)

## Speech tab

Open any of Together's speech models and you get a **Speech** tab with both halves:

- **Text to speech** runs `cartesia/sonic`, `hexgrad/Kokoro-82M` or `canopylabs/orpheus-3b-0.1-ft`. The voice picker is populated from your account's live voice catalogue; Kokoro and Orpheus fall back to their published rosters if that call is unavailable. Clips come back as mp3 so they play inline.
- **Speech to text** always runs `openai/whisper-large-v3` — it is the only model Together's transcription route accepts — and is requested with diarization on, so **Show word timings** lists every word with its speaker label.

See [Speech testing](../features/speech-testing.md) for how the panel works in general.

![The Speech tab on the Kokoro-82M model, showing the voice picker and a synthesized clip](https://agent-assets.infrawrench.com/docs-screenshots/plugins/together/speech-tab-kokoro.png)

## Costs

Spend comes from Together's billing usage API (`GET /v1/billing/usage`), collected daily. Each row is one priced line item:

- **Service** is Together's product name, such as `Serverless Inference - Input Tokens` or a GPU cluster product.
- **Resource** is the model, when the line item names one.
- **Tags** carry everything else Together attaches to the line item, such as `api_key_id` and `project_id` on inference usage, so you can break spend down by key or project.

The report covers the whole Together organization the key belongs to, not just its project. Current-month data can lag by up to an hour and earlier months by up to a day; Infrawrench re-reads the last three days on every pass to pick up those corrections.

The billing usage API is in beta and Together enables it per organization. Until it is on, the account shows a setup notice in Costs with a link to request access from Together support; nothing else needs to change once it is enabled.

<insert [The Costs page filtered to a Together AI account, broken down by service] here>

## Managed endpoint metrics

A managed endpoint's detail page summarizes the last 24 hours: requests, error rate, requests and tokens per second, time to first token, end-to-end and inter-token latency at p50, p90 and p99, GPU, GPU memory, CPU and memory utilization, and input and output token totals.

The **Metrics** tab charts the same measurements over any time range, at one-minute buckets for ranges up to six hours, hourly up to two weeks, and daily beyond that.

<insert [The Metrics tab of a Together managed endpoint showing latency percentiles and GPU utilization] here>

## GPU clusters

Create a cluster without knowing Together's identifiers:

- **GPU type** lists the types Together currently offers, with the regions that have each one.
- **Region** only shows regions offering the GPU type you picked.
- **NVIDIA driver** lists the driver, CUDA and OS combinations offered in the chosen region.
- **Billing** is on demand (yours until you delete it), reserved (prepaid for a number of days) or scheduled capacity (a future start and end time).
- **Shared volume** attaches an existing volume, creates a new one with the cluster, or skips storage.

After creation you can edit the GPU count, the cluster type, the requested preemptible GPUs, the reserved GPU count (reserved clusters only) and the reservation end time (prepaid clusters only). GPU counts must be multiples of 8; Infrawrench checks that before sending the change.

Kubernetes clusters get a **Kubernetes** tab. Its kubeconfig is fetched from Together when the tab opens rather than stored with the cluster listing.

<insert [A Together GPU cluster detail page showing capacity, GPU worker nodes and the Kubernetes tab] here>

## Notable flows

- **Create a dedicated endpoint** from a picker of dedicated-capable models and a hardware picker showing GPU count and per-minute price — no SKU strings to look up.
- **Start / stop an endpoint** from the detail page. Stopping releases the reserved GPUs; the next request pays a cold start.
- **Cancel a fine-tune or a batch job** while it is still running.
- **Delete a managed endpoint** and the plugin removes its deployments first, which Together requires.
- **Grow a shared volume** by editing its size in TiB. Together refuses to delete a volume while a cluster still uses it.

## Tips & limits

- **Model pricing is list pricing.** The model detail page shows Together's published rates; what you were actually charged is in Costs.
- **There is no API-key management API**, so keys can only be created and revoked in the Together dashboard.
- **Pagination is split.** The v1 lists (models, fine-tunes, files, endpoints, batches, GPU clusters, shared volumes) return everything in one response and accept no paging parameters at all. Only the v2 managed-inference endpoints paginate. Very large accounts will see the v1 lists grow rather than page.
- **Hardware availability is model-specific.** The Hardware list shows availability only when it was queried for a particular model, so the standalone list leaves it blank.
- **A dedicated endpoint's model and hardware are fixed at creation.** You can rename it, rescale it and start or stop it, but changing the model means creating a new endpoint.
- **Transcription uploads are capped at 25 MB in the Speech tab**, well under Together's own 500 MB limit, because the clip is base64-encoded through the app's ordinary request path. Send long recordings through Together's batch transcription endpoint instead.
