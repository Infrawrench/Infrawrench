---
title: SambaNova
description: Browse the SambaCloud model catalogue with list prices, context length and output limits, chat with any model in the Playground, and test Whisper transcription.
sidebar_order: 43
---

## What you can manage

- **Models**: every model SambaCloud serves, with its context length, maximum completion tokens, and list price per million input and output tokens (per audio hour for transcription models).
- **Playground**: chat models get a **Playground** tab that streams from `api.sambanova.ai/v1/chat/completions`.
- **Speech**: Whisper models, when SambaCloud lists one, get a **Speech** tab that transcribes a recorded or uploaded clip of up to 25 MB.

## Credentials

1. Sign in to [cloud.sambanova.ai](https://cloud.sambanova.ai) and open **API Keys**.
2. Create a key and paste it into **API Key**. Keys have no scopes.

The model list itself is public, so the key is checked with a free token-count request when you add the account.

<insert [SambaNova Add-account form with the API Key field and the Create an API key help link] here>

## Playground

<insert [SambaNova model detail page showing pricing and limits, with the Playground tab streaming a reply from gpt-oss-120b] here>

## Status

Incidents on status.sambanova.ai are matched to the model they name. An API Gateway incident affects every model and is shown as provider-wide; incidents that only touch the web playground or the community site are ignored.

## Tips & limits

- **There is no usage, billing, key-management or batch API.** Spend, usage and rate-limit tiers are on the cloud console's Billing and Usage pages; the model page links there.
- Free-tier keys have low per-minute and per-day limits, and a daily token cap. A 429 in the Playground means one of them was reached; linking a payment method moves the account to the Developer tier.
- Prices come straight from SambaCloud's model list, so they are list prices rather than anything negotiated.
