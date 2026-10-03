---
title: DeepSeek
description: DeepSeek's complete REST surface; the model list, the prepaid credit balance, and Files API uploads.
sidebar_order: 33
---

DeepSeek publishes an inference API and very little else. This plugin covers the whole of the rest of it: the model list, the balance, and the Files API.

## What you can manage

- **Models**: the models this key can call, with the display name, context window, maximum output, input and output modalities, supported thinking-effort levels and default, and how the Anthropic-compatible endpoint handles system prompt updates, all as `GET /models` reports them. The documented per-model concurrency cap, the published peak and off-peak price sheet, and any retired model names that still route to the model are filled in from DeepSeek's docs. Read-only.
- **Balance**: the account's prepaid credit, one row per currency, split into granted and topped-up amounts. Read-only.
- **Files**: images uploaded through the Files API for reuse by `file_id` in chat requests, with size, upload time and expiry (delete). Uploading happens from your own code; the app lists and deletes.

## Credentials

One field. [platform.deepseek.com](https://platform.deepseek.com/api_keys) → **API keys**. The value starts with `sk-`.

There is no separate admin or management key, and no API for creating or revoking keys, so rotation happens in the DeepSeek console.

![DeepSeek Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepseek/add-account.png)

## Tips & limits

- **Retired model names still work.** `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are accepted and served by `deepseek-flash` (V4.1-Flash) at its price, but they no longer appear in `GET /models`. The `deepseek-flash` page lists them under **Legacy Aliases** so you can find old references in your code.
- **Peak and off-peak pricing.** Peak hours are 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday, excluding Chinese public holidays; every other hour bills at half the peak rate. The model page shows both columns. These figures are published on DeepSeek's pricing page rather than returned by the API.
- **Files are images only and may never expire.** The Files API accepts JPEG, PNG, GIF and WebP up to 64 MiB each, with an account quota of 25 GiB across at most 10,000 files. A file uploaded without `expires_after` is kept until deleted, and the file page says **Never** for it.
- **There is no speech API.** DeepSeek ships no text-to-speech or transcription endpoint, so this plugin has no [Speech tab](../features/speech-testing.md).
- **There is no usage or billing API either** — only the point-in-time balance. A cost chart built from a balance snapshot would be a fabrication, so this plugin declares no cost capability at all and shows the balance as a balance.
- **Rate limiting is by concurrency, not by requests or tokens per minute.** DeepSeek caps concurrent in-flight requests per model and answers `429` over the cap. Those caps are published in the docs rather than returned by the API, so the model page fills them in.
- **Balance amounts arrive as decimal strings**, not numbers — worth knowing if you script against the same endpoint.
- **The canonical base URL has no `/v1` segment.** `/chat/completions`, `/models` and `/user/balance` are the real paths; `/v1` is accepted only so the OpenAI SDK can be pointed at DeepSeek unchanged.
