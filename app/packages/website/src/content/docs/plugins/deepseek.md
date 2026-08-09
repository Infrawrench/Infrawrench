---
title: DeepSeek
description: DeepSeek's complete REST surface — the model list and the prepaid credit balance.
sidebar_order: 33
---

DeepSeek publishes an inference API and almost nothing else. This plugin covers the whole of the rest of it, which is two endpoints.

## What you can manage

- **Models** — the models this key can call, with the documented per-model concurrency cap. Read-only.
- **Balance** — the account's prepaid credit, one row per currency, split into granted and topped-up amounts. Read-only.

## Credentials

One field. [platform.deepseek.com](https://platform.deepseek.com/api_keys) → **API keys**. The value starts with `sk-`.

There is no separate admin or management key, and no API for creating or revoking keys, so rotation happens in the DeepSeek console.

![DeepSeek Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs/screenshots/plugins/deepseek-add-account.png)

## Tips & limits

- **There is no speech API.** DeepSeek ships no text-to-speech or transcription endpoint, so this plugin has no [Speech tab](../features/speech-testing.md).
- **There is no usage or billing API either** — only the point-in-time balance. A cost chart built from a balance snapshot would be a fabrication, so this plugin declares no cost capability at all and shows the balance as a balance.
- **Rate limiting is by concurrency, not by requests or tokens per minute.** DeepSeek caps concurrent in-flight requests per model and answers `429` over the cap. Those caps are published in the docs rather than returned by the API, so the model page fills them in.
- **Balance amounts arrive as decimal strings**, not numbers — worth knowing if you script against the same endpoint.
- **The canonical base URL has no `/v1` segment.** `/chat/completions`, `/models` and `/user/balance` are the real paths; `/v1` is accepted only so the OpenAI SDK can be pointed at DeepSeek unchanged.
