---
title: OpenRouter
description: Browse the OpenRouter catalogue with per-provider pricing, uptime and latency percentiles, manage API keys, guardrails, workspaces, budgets, BYOK credentials and credits, and run speech synthesis and transcription from the Speech tab.
sidebar_order: 36
---

Use this plugin to compare who serves each model on OpenRouter, keep an eye on spend, and manage your keys, guardrails and workspaces.

## What you can manage

- **Models**: the full catalogue across every modality, with price per million tokens, context length, tokenizer and knowledge cutoff.
- **Model endpoints**: each provider's own endpoint for a model, with its price, uptime over 5 minutes, 30 minutes and 1 day, latency from p50 to p99, and throughput. This tells you which provider for a model is the cheap slow one and which is the fast expensive one today.
- **Providers**: every upstream OpenRouter routes to, with headquarters and datacenter regions for data residency checks.
- **API keys**: create, edit and delete, including per-key credit limits, reset interval (daily, weekly or monthly), expiry, whether BYOK usage counts against the limit, and the key's workspace. Each key has a Metrics tab with requests, spend, tokens and latency.
- **Guardrails**: spend limits and routing policy (allowed and blocked providers and models, data regions, zero data retention, training opt-ins), with the API keys they apply to. Create, edit and delete.
- **Workspaces**: default models and provider sort, observability logging settings, daily, weekly, monthly and lifetime budgets, member count, and a Metrics tab. Create, edit and delete.
- **BYOK credentials**: your own keys for upstream providers, with fallback and BYOK-only routing. Create, edit and delete.

## Connect with OpenRouter

Click **Connect with OpenRouter** on the add-account form. You sign in to OpenRouter and it creates an inference API key named **Infrawrench** for you, so you don't have to copy one. The key works until you delete it under [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).

OpenRouter has no narrower kind of key, so this one can make requests billed to your credits. Infrawrench only uses it when you act, in the **Speech** tab.

This is an inference key, not a management key, and OpenRouter only creates management keys in its own settings. On its own it shows the model catalogue, endpoints, providers and the Speech tab. For API keys, guardrails, workspaces, BYOK credentials, credits and costs, add a **Management Key** to the account. You can do that at any time.

Connect with OpenRouter works in the web app, in the desktop app's cloud mode, and for accounts stored locally on the desktop (which sign in through your browser).

<insert [OpenRouter add-account form showing the Connect with OpenRouter button above the Management Key and Inference API Key fields] here>

## Add keys by hand

OpenRouter has **two kinds of key**, and neither can do the other's job. Enter at least one.

**Management Key**: get it from [openrouter.ai/settings/management-keys](https://openrouter.ai/settings/management-keys). OpenRouter used to call this a _provisioning key_. You need it for credits, activity and API keys, which is almost everything in the console. Without it, you only see the model catalogue, endpoints and providers.

**Inference API Key**: get it from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), or use the one **Connect with OpenRouter** creates. It's a normal `sk-or-v1-…` key. The **Speech tab** needs one, since management keys can't make requests to models. Without it, every list still works and the Speech tab explains what's missing.

![OpenRouter Add-account form showing the required Management Key field and the optional Inference API Key field, with the description explaining why both exist](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openrouter/add-account.png)

## Compare providers for a model

Open any model and scroll to **Provider endpoints**. Each provider serving that model gets one line with its prompt and completion price per million tokens, context window, 1-day uptime, p50 and p99 latency, and p50 throughput.

![OpenRouter model detail page with the Provider endpoints table showing several providers, their prices, uptime and latency percentiles side by side](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openrouter/provider-endpoints.png)

The top-level **Model Endpoints** list only covers the most popular models. A model's own page always shows all of its endpoints.

## Test speech

Models that produce **speech** or **transcription** have a **Speech** tab.

- **Synthesize** returns MP3. The voice picker lists the voices each speech model supports, with the voices for the model you're looking at first. Every entry says which model it belongs to.
- **Transcribe** turns a recorded or uploaded clip into text.

Both halves share one model picker. If you leave it on a transcription model and press Synthesize, the app switches to a speech model for you.

## Set up guardrails, workspaces and BYOK

All three need the management key.

### Create a guardrail

Pick everything the guardrail references from lists: allowed and blocked providers, allowed and blocked models, and the API keys to **Apply to API keys**. The detail page shows the budget, the routing policy, any built-in content filters (email, phone numbers, secrets and so on) and the assigned keys.

When you edit a guardrail you can change its limit, reset interval, flags and policy lists. Enter the lists as comma-separated provider slugs or model ids, the same way the detail page shows them. Assign keys when you create the guardrail, or in the OpenRouter dashboard.

<insert [OpenRouter Create Guardrail form with the allowed providers multi-select open and two API keys ticked under Apply to API keys] here>

### Set workspace budgets

Each workspace has its own budgets, one per interval. Fill in **Daily**, **Weekly**, **Monthly** or **Lifetime Budget** to set one. Clear it (or set it to 0) to remove it. Set **BYOK Counts Toward Budgets** in the same edit. You can't delete the default workspace from here.

### Add BYOK credentials

Pick a provider and paste that provider's key. OpenRouter stores it encrypted and never shows it again, so you only see its masked label. You can later turn fallback to OpenRouter credits and BYOK-only routing on or off, and change the allowed models.

## See costs and usage

Spend is broken down by day, model and the provider that actually served the request.

Models, API keys and workspaces each have a **Metrics** tab, with the same data as OpenRouter's Activity dashboard:

- requests, spend and BYOK spend
- prompt, completion and reasoning tokens
- prompt cache hit rate
- provider time to first token at p50 and p90, and throughput (completion tokens per second) at p50

Buckets are per minute for ranges up to six hours, hourly up to a week, and daily beyond that. OpenRouter only gives latency and throughput for ranges up to 31 days, so wider ranges show usage only. If OpenRouter's analytics refuse your key, a model's tab shows daily spend, requests and tokens instead.

<insert [OpenRouter API key Metrics tab showing requests, spend and time to first token over the last 30 days] here>

Your remaining credit shows on API key cards.

## Tips & limits

- **Cost history covers the last 30 completed UTC days only.** OpenRouter has nothing older, so the cost chart starts 30 days back.
- **Prices are shown in dollars per million tokens** so you can compare models directly.
- **Uploads are capped at 25 MB.**
- **A new API key is shown once.** OpenRouter can't show it again.
- **Mid-stream errors aren't HTTP errors.** If you're debugging your own OpenRouter integration: once a streamed response sends its first token, a failure arrives as an event with `finish_reason: "error"`, not as a status code.
