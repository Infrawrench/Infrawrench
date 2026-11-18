---
title: SambaNova
description: Browse the SambaCloud model catalogue with list prices, context length and output limits, chat with any model in the Playground, and test Whisper transcription.
sidebar_order: 43
---

## What you can manage

- **Models**: every model SambaCloud serves, with its context length, maximum completion tokens, and list price per million input and output tokens (per audio hour for transcription models).
- **Playground**: chat models have a **Playground** tab that streams replies.
- **Speech**: Whisper models, when SambaCloud lists one, have a **Speech** tab that transcribes a recorded or uploaded clip of up to 25 MB.

## Connect your account

1. Sign in to [cloud.sambanova.ai](https://cloud.sambanova.ai) and open **API Keys**.
2. Create a key and paste it into **API Key**. Keys have no scopes.

The key is checked with a free request when you add the account.

![SambaNova Add-account form with the API Key field and the Create an API key help link](https://agent-assets.infrawrench.com/docs-screenshots/plugins/sambanova/add-account.png)

## Try a model in the Playground

![SambaNova model detail page for gpt-oss-120b on the Playground tab, with a reply to a question](https://agent-assets.infrawrench.com/docs-screenshots/plugins/sambanova/model-playground.png)

## Status

SambaNova incidents show against the model they name. An API Gateway incident affects every model and shows as provider-wide. Incidents that only touch the web playground or the community site are left out.

## Tips & limits

- **There's no usage, billing or key data.** Check spend, usage and rate-limit tiers on the cloud console's Billing and Usage pages. The model page links there.
- Free-tier keys have low per-minute and per-day limits, and a daily token cap. A 429 in the Playground means you hit one of them. Adding a payment method moves the account to the Developer tier.
- Prices are SambaCloud's list prices, not anything negotiated.
