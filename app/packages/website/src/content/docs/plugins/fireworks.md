---
title: Fireworks AI
description: Manage Fireworks deployments, routers, models, datasets, SFT, DPO and RFT jobs, evaluators, batch jobs, users, API keys, secrets and quotas, with real usage costs.
sidebar_order: 39
---

Fireworks AI serves open models both serverless and on dedicated GPU capacity you control. This plugin covers the whole control plane, including the one thing most inference providers do not expose: real per-day spend.

## What you can manage

- **Deployments** — dedicated capacity, its replica window, and scaling
- **Models** — base models and LoRA add-ons, with context length and capabilities
- **Deployed models** — LoRA add-ons attached to a deployment
- **Datasets** — uploaded JSONL, with example and token counts
- **Routers**: spread one model string across several deployments, with weighted-random or even-load balancing; create, edit and delete
- **Fine-tuning jobs** — supervised runs, with hyperparameters, progress and estimated cost; cancel and resume
- **DPO jobs**: preference fine-tuning (DPO or ORPO) with the loss method, KL beta and training settings; resume and delete
- **RFT jobs**: reinforcement fine-tuning against an evaluator's reward, with epoch and token progress; cancel, resume and delete
- **Evaluators**: the scoring code behind evaluation jobs and RFT, with build state and source; edit the name and description
- **Evaluation jobs**: an evaluator's run over a dataset, with the metrics it reported
- **Batch inference jobs** — progress, success and failure counts, and the output dataset
- **Users**: members and service accounts with their roles; invite, create and change roles
- **API keys** — full create, with the plaintext shown once
- **Secrets**: the account-scoped secrets jobs reference by key name; create them here
- **Quotas**: accelerator quota per region, how much of it is in use, and an editable enforced limit

## Credentials

Two fields, both required.

- **API Key** — create one at [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys). The same key works for inference and for the control plane.
- **Account ID** — your Fireworks account id, e.g. `my-team`.

The account id is required because **Fireworks has no whoami endpoint**. Every control-plane path is `/v1/accounts/{account_id}/…`, so without it nothing lists at all. You can read it off any of your model strings: `accounts/my-team/models/my-model` → `my-team`. It is also shown at the top of app.fireworks.ai.

![The Fireworks AI Add-account form showing the API key and Account ID fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fireworks/add-account.png)

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

![The cost view filtered to a Fireworks account, showing daily spend broken down by model](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fireworks/cost-graph.png)

## Metrics

Deployments get a **Metrics** tab charting accelerator-seconds per day. Models chart prompt and completion tokens per day. Both come from the daily billing-usage export, so the window is capped at 31 days.

A deployment's detail page also shows **Live performance**, read from Fireworks' Prometheus metrics endpoint (`/v1/accounts/{account}/metrics`) when the page opens: requests and errors per second, prompt tokens per second and the share served from the prompt cache, time to first token and end-to-end latency at p50 and p99, per-token generation time, generation and prefill queue time, prefill time, concurrent requests, and KV cache block and slot utilization. These are Fireworks' one-minute windows as of now, not history, so they are not charted; Fireworks limits the endpoint to six requests a minute per account, and the section is simply left out when a request is throttled or the deployment has had no traffic. To chart them over time, point your own Prometheus or Grafana at the same endpoint.

<insert [Fireworks deployment detail page showing the Live performance section with request rate, time to first token and KV cache utilization] here>

## Logs

- **Evaluation jobs**: the **Logs** tab shows the job's execution log, downloaded from the short-lived signed URL Fireworks issues for it. Before the job starts writing, the tab says so.
- **Evaluators**: the **Logs** tab shows the build log, which is where a `BUILD_FAILED` evaluator explains itself.
- **Deployments** and **users**: the **Logs** tab shows the account audit log from the last 30 days, filtered to that deployment, or to actions taken by that user's email: time, outcome, who, the API method, the resource and the client IP. Audit logs are only available on Enterprise accounts; elsewhere the tab explains that instead of failing.

<insert [Fireworks deployment Logs tab showing audit entries for creating and scaling the deployment] here>

## Notable flows

- **Scale a deployment** by editing its replica count. Fireworks exposes scaling as a dedicated RPC separate from editing the min/max window, and the plugin sends whichever of the two your edit implies.
- **Create an API key** against any user or service account in the account. The plaintext value is returned exactly once, in the create response, and is shown to you as a warning — Fireworks never stores it, so there is no way to read it back later. Create a replacement instead.
- **Cancel or resume a fine-tuning job** from its detail page. RFT jobs offer the same pair; DPO jobs can only be resumed, because Fireworks has no cancel verb for them.
- **Create a router** by ticking deployments in a multi-select, then choosing the strategy (weighted random by replica count, or even load per replica) and whether other accounts may query it. The optional model is offered from the base models those deployments serve; leave it empty when the deployments span regions, which Fireworks requires. Routers Fireworks generates for a deployment are read-only and are removed with the deployment.
- **Invite a user** by email, or create a service account, with a role picker (admin, user, contributor, inference user, or custom with a permission preset). Fireworks has no delete-user API, so removing someone is done in the dashboard.
- **Create a secret** from a key name and a value. The value is write-only; the secret id is derived from the key name (`WANDB_API_KEY` becomes `wandb-api-key`).
- **Cap a quota** by editing its enforced limit.

<insert [Fireworks Create Router form with the Deployments multi-select open, two deployments ticked, and the routing strategy picker below] here>

## Tips & limits

- **Audio inference is gone.** Fireworks removed transcription and text-to-speech from its public API on 10 June 2026 — the documentation 404s and the audio hosts reject requests. This plugin therefore has no [Speech tab](../features/speech-testing.md), and there is no Fireworks path to add one back. Historical audio line items can still appear in billing.
- **Large numbers arrive as strings.** Example counts, token counts and quota values are 64-bit integers that the API returns JSON-encoded as strings. The plugin converts them; if you script against the API yourself, expect strings.
- **Page size caps at 200.** Larger values are silently coerced.
- **API-key listing does not paginate.** Fireworks documents pagination on that route as a TODO, so a very large account may not show every key.
- **Secret values are write-only.** Neither a get nor a list ever returns them, so only the key name is shown.
- **Evaluators are created through Fireworks' upload-and-build flow** (firectl or the Eval Protocol SDK), which packages and uploads source code. The plugin lists, edits and deletes them but does not create them.
- **Quotas can be lowered but not raised.** You can set the enforced limit below your approved maximum to cap spend; going above the maximum needs a usage-limit increase request with Fireworks.
