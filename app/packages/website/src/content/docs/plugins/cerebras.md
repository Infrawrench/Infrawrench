---
title: Cerebras
description: Browse the Cerebras Inference model catalogue with prices and limits, chat with any model in the Playground, run batches, and manage Dedicated Inference endpoints and custom model versions.
sidebar_order: 42
---

## What you can manage

- **Models**: every model your key can call, joined with Cerebras' public catalogue for the input and output price per million tokens, context length, maximum completion tokens, capabilities (tools, structured outputs, reasoning, vision), quantization and preview or deprecated state. Each model has a **Playground** tab.
- **Batches** (Private Preview): create a batch from an uploaded file, follow its progress and request counts, and cancel it.
- **Files** (Private Preview): batch input and output files, with size and expiry. Delete them when you are done.
- **Dedicated Endpoints** (Private Preview): your reserved-capacity endpoints, the model version each one serves and its rollout state. **Deploy version** swaps in another uploaded version without changing the endpoint id. A **Playground** and a **Metrics** tab are included.
- **Model Versions** (Private Preview): custom weights uploaded from S3 for a Dedicated Inference architecture. Upload a new version, edit its aliases, and delete it.

## Credentials

1. Open [cloud.cerebras.ai](https://cloud.cerebras.ai) and go to **API Keys**. On a paid plan, pick the project first: the key inherits that project's rate limits.
2. Click **Generate API Key** and paste the `csk-…` value into **API Key**. Keys have no scopes.

For Dedicated Inference, also fill the optional fields:

- **Organization ID** (`org_…`, from the console's **Settings** page) to see endpoint metrics.
- **Organization Name** (the prefix of your endpoint ids, for example `my-org` in `my-org-gpt-oss-120b`) and the **Management API Key** from the **Management API keys** section of the API Keys page, to list endpoints and model versions and to deploy.

<insert [Cerebras Add-account form showing the API Key field and the collapsed Dedicated Inference fields] here>

## Playground

Open a model or a dedicated endpoint and use the **Playground** tab. Messages stream from `api.cerebras.ai/v1/chat/completions`; a dedicated endpoint is called with its endpoint id as the model.

<insert [Cerebras model detail page with pricing and limits, and the Playground tab streaming a reply] here>

## Metrics

A dedicated endpoint's **Metrics** tab reads Cerebras' Prometheus endpoint: requests (total, successful, failed), input and output tokens, cache reads and cache rate, endpoint status, and queue time, end-to-end latency, time to first token and time per output token at avg, p50, p90, p95 and p99. Cerebras reports **only the last complete minute**, so each metric is a single point, and the route allows six requests a minute per organization.

## Status

Incidents on status.cerebras.ai are matched to your models and endpoints. Incidents that only affect the Developer Console are ignored.

## Tips & limits

- **There is no usage, billing or API key management API.** Spend, request logs, rate limits and keys stay in the Cloud console; the model page links there.
- Batches and files are in Private Preview. Organizations without access see empty lists rather than errors. A batch always targets `/v1/chat/completions` with a 24-hour window, the only values Cerebras accepts today, and the input file must be under 200 MB and 50,000 requests.
- Dedicated Inference endpoints themselves are provisioned by Cerebras; the API can deploy versions to them but not create or delete them.
- Model version uploads read from an S3 bucket that has the cross-account policy Cerebras gives you. The upload is asynchronous: watch **Sync Status** until it reads `done` before deploying.
