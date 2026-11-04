---
title: fal
description: Track the fal Model API endpoints you use with their prices, spend and request analytics, inspect Serverless apps, queues, revisions and logs, manage Compute instances and API keys, and read billed usage and your credit balance.
sidebar_order: 45
---

Connect fal to see which models you call and what they cost, keep an eye on your Serverless apps, and manage Compute instances and API keys.

## What you can manage

- **Models**: every Model API endpoint your workspace called in the last 30 days. You see its catalogue name and category, unit price, units used and cost over those 30 days, the queue URL, and the 20 most recent requests. The **Metrics** tab charts request counts, successes, user and server errors, cold boots, execution time p50/p90/p99 and queue time p50/p90.
- **Serverless Apps**: your deployed apps with machine type, regions, routes, concurrency, keep-alive and timeouts, the current queue size, revision history (and which one is serving), recent requests, a **Logs** tab and the same **Metrics** as models. **Flush queue** drops every pending request.
- **Compute Instances**: dedicated H100 machines with region, status and IP. Delete an instance when you're done with it.
- **API Keys**: every key with its alias, scope and creator. To rotate a key, use **Get credentials > Create a replacement key**. It creates a new key with the same alias (shown once). Then delete the old one.
- **Workflows**: your workflows and the endpoints they chain.

## Connect your account

1. Open [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) and create a key with the **ADMIN** scope.
2. Paste the whole value, `key_id:key_secret`, into **Admin API Key**.

On fal, usage, cost, credits, API keys and Compute instances are admin-only. An **API**-scope key still works for Serverless apps, workflows, analytics and logs, but the model list, costs and credits stay empty.

<insert [fal Add-account form with the Admin API Key field and the Create an API key help link] here>

## Costs and credits

Spend is shown per UTC day, after discounts:

- **Model APIs**, per endpoint, tagged with the authentication method (key or user), with the billed units (images, megapixels, seconds and so on) as usage.
- **Serverless**, per app, tagged with machine type, environment and surge pricing, with machine-seconds as usage.

Your **credit balance** is tracked over time so you can see when it will run out.

<insert [Costs page filtered to a fal account, broken down by model endpoint for the last 30 days] here>

## Status

Incidents and in-progress maintenance from status.fal.ai show as provider-wide, because fal's status summary doesn't say which component they affect.

## Tips and limits

- Only endpoints your workspace used in the last 30 days are listed. Call a model once and it appears on the next refresh.
- Usage is fal's running estimate until the month is invoiced, so the last few days can change.
- Change app scaling and deployments with `fal deploy` and `fal apps scale`. In Infrawrench they're read-only.
- Creating Compute instances needs an SSH key and capacity confirmation, so do that in the fal dashboard.
