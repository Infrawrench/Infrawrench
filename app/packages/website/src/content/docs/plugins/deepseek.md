---
title: DeepSeek
description: See the DeepSeek models your key can call, your prepaid credit balance, and the images you uploaded through the Files API.
sidebar_order: 33
---

DeepSeek offers an inference API and very little else. Connect it to see your models, your balance and your uploaded files.

## What you can manage

- **Models**: the models your key can call, with the display name, context window, maximum output, input and output modalities, supported thinking-effort levels and default, and how the Anthropic-compatible endpoint handles system prompt updates. Each model also shows DeepSeek's published concurrency cap, peak and off-peak prices, and any retired model names that still route to it. Read-only.
- **Balance**: your prepaid credit, one row per currency, split into granted and topped-up amounts. Read-only.
- **Files**: images uploaded through the Files API for reuse by `file_id` in chat requests, with size, upload time and expiry. You can delete them. Uploads happen from your own code.

## Connect your account

Paste one API key from [platform.deepseek.com](https://platform.deepseek.com/api_keys) > **API keys**. It starts with `sk-`.

DeepSeek has no separate admin key and no API for creating or revoking keys, so rotate keys in the DeepSeek console.

![DeepSeek Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepseek/add-account.png)

## Tips & limits

- **Retired model names still work.** `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are served by `deepseek-flash` (V4.1-Flash) at its price, but they no longer show in the model list. The `deepseek-flash` page lists them under **Legacy Aliases** so you can find old references in your code.
- **Peak and off-peak pricing.** Peak hours are 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday, excluding Chinese public holidays. Every other hour bills at half the peak rate. The model page shows both.
- **Files are images only and may never expire.** The Files API accepts JPEG, PNG, GIF and WebP up to 64 MiB each, with an account quota of 25 GiB across at most 10,000 files. A file uploaded without `expires_after` is kept until you delete it, and its page says **Never**.
- **No Speech tab.** DeepSeek has no text-to-speech or transcription API. See [Speech testing](../features/speech-testing.md) for providers that do.
- **No cost chart.** DeepSeek has no usage or billing API, only the current balance, so you see the balance rather than spend over time.
- **Rate limits are by concurrency.** DeepSeek caps how many requests per model can run at once and returns `429` over the cap. The model page shows the published caps.
- **Base URL.** If you script against DeepSeek, the base URL has no `/v1` segment: `/chat/completions`, `/models` and `/user/balance` are the paths. `/v1` is accepted so the OpenAI SDK works unchanged. Balance amounts come back as decimal strings, not numbers.
