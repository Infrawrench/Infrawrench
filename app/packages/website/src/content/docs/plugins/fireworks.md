---
title: Fireworks AI
description: Manage Fireworks deployments, routers, models, datasets, SFT, DPO and RFT jobs, evaluators, batch jobs, users, API keys, secrets and quotas, with real usage costs.
sidebar_order: 39
---

Connect Fireworks AI to manage your serverless and dedicated model deployments, fine-tuning and batch jobs, and see your real daily spend per model.

## What you can manage

- **Deployments**: dedicated capacity, its replica window, and scaling.
- **Models**: base models and LoRA add-ons, with context length and capabilities.
- **Deployed models**: LoRA add-ons attached to a deployment.
- **Datasets**: uploaded JSONL, with example and token counts.
- **Routers**: spread one model string across several deployments, with weighted-random or even-load balancing. Create, edit and delete.
- **Fine-tuning jobs**: supervised runs, with hyperparameters, progress and estimated cost. Cancel and resume.
- **DPO jobs**: preference fine-tuning (DPO or ORPO) with the loss method, KL beta and training settings. Resume and delete.
- **RFT jobs**: reinforcement fine-tuning against an evaluator's reward, with epoch and token progress. Cancel, resume and delete.
- **Evaluators**: the scoring code behind evaluation jobs and RFT, with build state and source. Edit the name and description.
- **Evaluation jobs**: an evaluator's run over a dataset, with the metrics it reported.
- **Batch inference jobs**: progress, success and failure counts, and the output dataset.
- **Users**: members and service accounts with their roles. Invite, create and change roles.
- **API keys**: create them, with the plaintext shown once.
- **Secrets**: the account-scoped secrets jobs reference by key name. Create them here.
- **Quotas**: accelerator quota per region, how much of it is in use, and an editable enforced limit.

## Connect your account

You need two fields, both required.

- **API Key**: create one at [app.fireworks.ai](https://app.fireworks.ai/settings/users/api-keys). The same key works for inference and for managing your account.
- **Account ID**: your Fireworks account id, for example `my-team`.

Without the account id nothing can be listed. You can read it off any of your model strings (`accounts/my-team/models/my-model` means `my-team`), and it is also shown at the top of app.fireworks.ai.

![The Fireworks AI Add-account form showing the API key and Account ID fields](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fireworks/add-account.png)

The deployment page shows both of Fireworks' API addresses, and the same key works for both:

- **Inference** at `https://api.fireworks.ai/inference/v1`, with the account in the model string (`accounts/my-team/models/llama-3`).
- **Account management** at `https://api.fireworks.ai/v1/accounts/{account_id}/…`, with the account in the path.

## Costs

Your Fireworks spend shows up per day and per model in the normal cost views, alongside every other provider.

Two things to know:

- **Account-wide costs need an account administrator key.** With a plain member key you see that member's own usage instead, and Infrawrench tells you if even that is refused.
- **Subtotals exclude fixed fees, invoice-level discounts, minimums, credits and taxes.** They are usage priced at your subscription rates, not an invoice.

![The cost view filtered to a Fireworks account, showing daily spend broken down by model](https://agent-assets.infrawrench.com/docs-screenshots/plugins/fireworks/cost-graph.png)

## Metrics

Deployments get a **Metrics** tab charting accelerator-seconds per day. Models chart prompt and completion tokens per day. Charts cover at most 31 days.

A deployment's detail page also shows **Live performance** when you open it: requests and errors per second, prompt tokens per second and the share served from the prompt cache, time to first token and end-to-end latency at p50 and p99, per-token generation time, generation and prefill queue time, prefill time, concurrent requests, and KV cache block and slot utilization.

These are Fireworks' current one-minute figures, not history, so they are not charted. Fireworks allows six of these requests a minute per account, and the section is left out when a request is throttled or the deployment has had no traffic. To chart them over time, point your own Prometheus or Grafana at Fireworks' metrics endpoint (`/v1/accounts/{account}/metrics`).

<insert [Fireworks deployment detail page showing the Live performance section with request rate, time to first token and KV cache utilization] here>

## Logs

- **Evaluation jobs**: the **Logs** tab shows the job's execution log. Before the job starts writing, the tab says so.
- **Evaluators**: the **Logs** tab shows the build log, which is where a `BUILD_FAILED` evaluator explains itself.
- **Deployments** and **users**: the **Logs** tab shows the account audit log from the last 30 days, filtered to that deployment or to actions taken by that user's email: time, outcome, who, the API method, the resource and the client IP. Audit logs are only available on Enterprise accounts. Elsewhere the tab tells you that.

<insert [Fireworks deployment Logs tab showing audit entries for creating and scaling the deployment] here>

## Common tasks

- **Scale a deployment** by editing its replica count.
- **Create an API key** for any user or service account in the account. The plaintext value is shown exactly once, as a warning. Fireworks never stores it, so you cannot read it back later. Create a replacement instead.
- **Cancel or resume a fine-tuning job** from its detail page. RFT jobs offer the same pair. DPO jobs can only be resumed, because Fireworks has no way to cancel them.
- **Create a router** by ticking deployments in a multi-select, then choosing the strategy (weighted random by replica count, or even load per replica) and whether other accounts may query it. The optional model is offered from the base models those deployments serve. Leave it empty when the deployments span regions, which Fireworks requires. Routers Fireworks generates for a deployment are read-only and are removed with the deployment.
- **Invite a user** by email, or create a service account, with a role picker (admin, user, contributor, inference user, or custom with a permission preset). Fireworks has no way to delete users through its API, so remove people in the Fireworks dashboard.
- **Create a secret** from a key name and a value. The value is write-only. The secret id comes from the key name (`WANDB_API_KEY` becomes `wandb-api-key`).
- **Cap a quota** by editing its enforced limit.

<insert [Fireworks Create Router form with the Deployments multi-select open, two deployments ticked, and the routing strategy picker below] here>

## Tips and limits

- **Audio inference is gone.** Fireworks removed transcription and text-to-speech from its public API on 10 June 2026. So there is no [Speech tab](../features/speech-testing.md) for Fireworks, and no way to add one back. Historical audio line items can still appear in billing.
- **Very large accounts may not show every API key.** Fireworks does not paginate its API key listing.
- **Secret values are write-only.** Only the key name is ever shown.
- **Evaluators are created with Fireworks' own tools** (firectl or the Eval Protocol SDK), which package and upload source code. You can list, edit and delete them here, but not create them.
- **Quotas can be lowered but not raised.** Set the enforced limit below your approved maximum to cap spend. Going above the maximum needs a usage limit increase request with Fireworks.
