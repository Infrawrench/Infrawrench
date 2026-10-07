---
title: fal
description: Track the fal Model API endpoints you use with their prices, spend and request analytics, inspect Serverless apps, queues, revisions and logs, manage Compute instances and API keys, and read billed usage and your credit balance.
sidebar_order: 45
---

## What you can manage

- **Models**: every Model API endpoint your workspace called in the last 30 days, with its catalogue name and category, unit price, units used and cost over those 30 days, the queue URL, and the 20 most recent requests. The **Metrics** tab charts request counts, successes, user and server errors, cold boots, execution time p50/p90/p99 and queue time p50/p90.
- **Serverless Apps**: your deployed apps with machine type, regions, routes, concurrency, keep-alive and timeouts, the current queue size, revision history (which one is serving), recent requests, a **Logs** tab and the same **Metrics** as models. **Flush queue** drops every pending request.
- **Compute Instances**: dedicated H100 machines with region, status and IP. Delete an instance when you are done with it.
- **API Keys**: every key with its alias, scope and creator. **Get credentials → Create a replacement key** mints a new key with the same alias (shown once) so you can rotate, then delete the old one.
- **Workflows**: your workflows and the endpoints they chain.

## Credentials

1. Open [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) and create a key with the **ADMIN** scope.
2. Paste the whole value, `key_id:key_secret`, into **Admin API Key**.

Usage, cost, credits, API keys and Compute instances are admin-only on fal. An **API**-scope key still works for Serverless apps, workflows, analytics and logs, but the model list (built from usage), costs and credits stay empty.

<insert [fal Add-account form with the Admin API Key field and the Create an API key help link] here>

## Costs and credits

Spend comes from fal's billing usage endpoints, per UTC day, after discounts:

- **Model APIs**, per endpoint, with the authentication method (key or user) as a tag and the billed units (images, megapixels, seconds…) as usage.
- **Serverless**, per app, with machine type, environment and surge pricing as tags and machine-seconds as usage.

The **credit balance** is read from your account billing and tracked over time so you can see when it will run out.

<insert [Costs page filtered to a fal account, broken down by model endpoint for the last 30 days] here>

## Status

Incidents and in-progress maintenance on status.fal.ai are shown as provider-wide; fal's status summary does not say which component they affect.

## Tips & limits

- fal's public catalogue has thousands of endpoints, so only the ones your workspace used in the last 30 days are listed. Call a model once and it appears on the next refresh.
- Usage is fal's running estimate until the month is invoiced, so the last few days can be restated.
- App scaling and deployments are changed with `fal deploy` and `fal apps scale`; the Platform API exposes them read-only.
- Creating Compute instances needs an SSH key and capacity confirmation, so it stays in the fal dashboard.
