---
title: Together AI
description: Dedicated endpoints, fine-tunes, files, batches, evaluations and GPU clusters on Together AI, with spend from the billing usage API and a Speech tab for text-to-speech and Whisper transcription.
sidebar_order: 37
---

Together AI runs open models as serverless inference, as dedicated GPU endpoints you reserve, and as batch and fine-tuning jobs. This plugin covers all of it from one account.

## What you can manage

- **Dedicated endpoints**: the original (v1) endpoints, a model pinned to reserved GPU hardware. Together no longer creates or restarts them, so you can rename, rescale, stop and delete them, and serve new models from a managed endpoint instead.
- **Managed endpoints**: the newer Dedicated Managed Inference (v2) endpoints. Create one, rename it, change its visibility, add, edit and delete its deployments, set how traffic is split between them, or delete it. Each shows the last 24 hours of traffic, latency, utilization and token totals, with a Metrics tab and a Logs tab of lifecycle events.
- **Models**: the serverless catalogue, with context length and Together's list pricing
- **Fine-tunes**: job status, hyperparameters, tokens processed, the model each one produced, its checkpoints and its event log
- **Files**: uploaded JSONL datasets, with line counts and validation errors
- **Batch jobs**: create one from an uploaded file, watch progress, cancel it
- **Evaluations**: classify, score and compare runs
- **Hardware**: the GPU configurations a dedicated endpoint can run on, with pricing
- **GPU clusters**: create, resize, change type and delete Kubernetes or Slurm Instant Clusters, with their worker nodes, attached volumes and a Kubernetes tab
- **Shared volumes**: create, grow and delete the regional storage GPU clusters mount

## Connect your account

Together AI has one kind of key. Create one at [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys) and paste it as **API Key**.

You don't need an admin key or a project id. Infrawrench finds the project from the key. Creating a managed endpoint needs a key made in the project you deploy to, not an organization key.

![The Together AI Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/together/add-account.png)

## Test speech

Open any of Together's speech models to get a **Speech** tab with both halves:

- **Text to speech** runs `cartesia/sonic`, `hexgrad/Kokoro-82M` or `canopylabs/orpheus-3b-0.1-ft`. The voice picker lists your account's voices. Clips play inline as mp3.
- **Speech to text** always runs `openai/whisper-large-v3`, the only model Together offers for transcription. Speaker labels are on, so **Show word timings** lists every word with its speaker.

See [Speech testing](../features/speech-testing.md) for how the panel works in general.

![The Speech tab on the Kokoro-82M model, showing the voice picker and a synthesized clip](https://agent-assets.infrawrench.com/docs-screenshots/plugins/together/speech-tab-kokoro.png)

## Costs

You see your real spend from Together's billing data, by day. Each row is one priced line item:

- **Service** is Together's product name, such as `Serverless Inference - Input Tokens` or a GPU cluster product.
- **Resource** is the model, when the line item names one.
- **Tags** carry everything else Together attaches to the line item, such as `api_key_id` and `project_id` on inference usage, so you can break spend down by key or project.

The report covers the whole Together organization the key belongs to, not just its project. Current-month data can lag by up to an hour and earlier months by up to a day, so the last few days may still change.

Together's billing data is in beta and turned on per organization. Until it's on, Costs shows a setup notice with a link to request access from Together support. Nothing else needs to change once it's turned on.

<insert [The Costs page filtered to a Together AI account, broken down by service] here>

## Managed endpoint metrics and events

A managed endpoint's detail page sums up the last 24 hours: requests, error rate, requests and tokens per second, time to first token, end-to-end and inter-token latency at p50, p90 and p99, GPU, GPU memory, CPU and memory utilization, and input and output token totals.

The **Metrics** tab charts the same measurements over any time range, in one-minute buckets for ranges up to six hours, hourly up to two weeks, and daily beyond that.

<insert [The Metrics tab of a Together managed endpoint showing latency percentiles and GPU utilization] here>

The **Logs** tab shows the endpoint's events: endpoint changes plus provisioning, scaling, readiness and rollout events from every deployment under it, oldest first. Each line has its time, severity, event type and source. Scaling events show the replica change (`replicas=1->2`). When a replica crashes, runs out of memory or fails to pull its image, Together's short diagnostic appears indented under the event. These are lifecycle events, not the model server's own output, which Together doesn't provide for managed endpoints.

<insert [The Logs tab of a Together managed endpoint showing deployment scaling and readiness events] here>

## Create a GPU cluster

Everything is picked from lists:

- **GPU type** lists the types Together currently offers, with the regions that have each one.
- **Region** only shows regions offering the GPU type you picked.
- **NVIDIA driver** lists the driver, CUDA and OS combinations offered in the chosen region.
- **Billing** is on demand (yours until you delete it), reserved (prepaid for a number of days) or scheduled capacity (a future start and end time).
- **Shared volume** attaches an existing volume, creates a new one with the cluster, or skips storage.

Afterwards you can edit the GPU count, the cluster type, the requested preemptible GPUs, the reserved GPU count (reserved clusters only) and the reservation end time (prepaid clusters only). GPU counts must be multiples of 8.

Kubernetes clusters have a **Kubernetes** tab.

<insert [A Together GPU cluster detail page showing capacity, GPU worker nodes and the Kubernetes tab] here>

## Things you can do

- **Create a managed endpoint** by picking a model and one of its certified configurations, which fixes the GPUs (GPU count, type and price shown where Together gives one), plus the replica range and an optional idle timeout. Infrawrench creates the endpoint and its first deployment and sends all traffic to it.
- **Edit a deployment** from the managed endpoint's Deployments table: its replica range, idle timeout and concurrent requests per replica. Set both replica bounds to 0 to stop it and end its billing, and raise them again to restart it. **Add deployment** and **Set traffic split** change how requests are shared between deployments.
- **Stop a dedicated endpoint** from its detail page. Together won't start a v1 endpoint again once it has stopped, so move its traffic to a managed endpoint first.
- **Cancel a fine-tune or a batch job** while it's still running.
- **Delete a managed endpoint**. Its deployments are taken out of the traffic split and removed first, as Together requires.
- **Grow a shared volume** by editing its size in TiB. Together won't delete a volume while a cluster still uses it.

## Tips & limits

- **Model pricing is list pricing.** The model detail page shows Together's published rates. What you actually paid is in Costs.
- **You can't manage API keys here.** Create and revoke them in the Together dashboard.
- **Hardware availability depends on the model.** The standalone Hardware list leaves availability blank.
- **A dedicated endpoint's model and hardware are fixed.** You can rename, rescale and stop it, but changing the model means creating a managed endpoint.
- **Transcription uploads are capped at 25 MB in the Speech tab**, well under Together's own 500 MB limit. Send long recordings through Together's batch transcription instead.
