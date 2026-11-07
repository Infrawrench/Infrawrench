---
title: Baseten
description: Manage Baseten models, deployments, environments, autoscaling, promotions, chains, Model APIs, training jobs and secrets, with billed spend per deployment and idle-replica detection.
sidebar_order: 50
---

Baseten runs model inference on dedicated GPUs (deployments you scale yourself), token-priced Model APIs, and training jobs. Connect it to manage all three and see your billed spend by model, deployment, instance type, training job and Model API.

## What you can manage

- **Models**: every model the key can see, with its production and development deployments. Rename a model from its Edit form.
- **Deployments**: status, active replicas, instance type and GPU, region, and the per-replica price. Edit min and max replicas, concurrency target, target utilization, autoscaling window, scale-down delay and (for BIS-LLM) the in-flight token target. Activate, deactivate, retry a failed build, promote to production, promote into any other environment, or scale min replicas to zero in one click.
- **Environments**: the stable endpoint for each model (production, staging, ...), the deployment serving it, any promotion in progress and how much traffic has moved. Edit its autoscaling, what happens to the previous deployment after a promotion, rolling deploys and whether requests queue or are rejected when full. Create new environments, promote a deployment into one, and pause, resume or cancel a promotion.
- **Chains**: multi-step pipelines, with their deployment count.
- **Model APIs**: the hosted models your workspace has added, with input and output price per million tokens, context length and the invoke URL.
- **Training projects and jobs**: status, instance type, GPUs per node and node count, dedicated or spot capacity, who started it, and any error. Stop a running job.
- **Secrets**: names and teams only. Create a secret, rotate its value from the Edit form, or delete it. Secret values are never shown.
- **Instance types**: every hardware option with GPU, memory and its published price per minute and per hour.

You never type an id. Models, environments, deployments and teams are offered as pickers.

## Connect your account

Paste an **API key** from [Settings, API keys](https://app.baseten.co/settings/api_keys).

- Use a personal key of an organization admin, or a team key with **Manage and call all team models**. A team key only sees its own team's models and secrets.
- Inference-only and metrics-only keys won't work.
- Costs need a key whose user can see the workspace's Billing page. Without it, everything else still works and the Costs page tells you the permission is missing rather than showing zero.

<insert [Baseten Add-account form showing the API key field] here>

## Costs

Spend matches Baseten's Billing page and is **billed, not estimated**:

- **Dedicated Inference**: per deployment, per day, with billed replica minutes. Rows carry `model`, `deployment`, `environment`, `instance_type` and `team` tags, so you can group by any of them in the cost explorer.
- **Chains**: per chain, tagged with the chainlet.
- **Training**: per training job.
- **Model APIs**: per model, per day, with input plus output tokens as the usage amount.
- **Loops**: serverless Loops per base model, per day, tagged `base_model`, with tokens as the usage amount. Dedicated Loops runs, samplers and trainers appear under the same service.

History starts on 1 January 2026, the earliest date Baseten provides. Amounts are before credits, because Baseten only reports credits as a total with no date.

<insert [Cost explorer filtered to a Baseten account, grouped by the deployment tag] here>

## Find idle deployments

A deployment that keeps **min replicas** above zero is billed every minute those replicas run, traffic or not. If a deployment had warm replicas but served no requests in the last 7 days, it appears on the [Potential savings](../features/orphan-finder.md) page with its recent cost. Its detail page shows the same warning, and **Scale to zero when idle** sets min replicas to 0 in one step.

The detail page also shows the **min-replica floor**: what the min replicas cost per month at the instance type's published price, before any traffic.

Development deployments are excluded, because Baseten pins them to 0 or 1 replica.

<insert [Baseten deployment detail page showing the idle replicas warning and the billed usage by day table] here>

## Metrics and logs

Deployments and environments have a **Metrics** tab: active, desired and starting replicas, inference requests (total and per status class), end-to-end latency and time to first byte at each quantile, concurrent requests, async queue size, GPU utilization and memory, CPU, memory, container restarts, and input and output tokens for BIS-LLM deployments. Charts cover at most the last 7 days.

Model APIs chart input, cached input and output tokens and request counts. Training jobs chart per-GPU utilization and memory, CPU and memory.

Deployments, environments and training jobs also have a **Logs** tab with the newest lines from the last 24 hours and a level filter (all, warnings and errors, errors only).

## Quotas

Training GPU capacity appears on the [quota radar](../features/quota-radar.md): concurrent GPUs of each type in use by training jobs against the organization's limit and any per-team limits.

## Sleep schedules and status

Put deployments and environments on a [sleep schedule](../features/sleep-schedules.md): stopping deactivates them, starting activates them. Incidents from Baseten's [status page](https://status.baseten.co) show in [provider status](../features/provider-status.md), so a Dedicated Inference, Model APIs or Training incident shows next to the affected resources.
