---
title: xAI
description: Browse Grok models, files, batches and voices, manage team API keys and read the audit log, and run Grok speech synthesis and transcription from the Speech tab.
sidebar_order: 35
---

## What you can manage

- **Models** — every model your key can call, folded into one list: chat and vision models from `/v1/language-models`, image generation models, and embedding models. Each carries its full price sheet, including the cached-prompt and long-context rates.
- **Voices** — xAI's built-in voices _and_ any custom voices your team has cloned, in a single list. Custom voices are editable and deletable; built-ins are read-only.
- **Files** — anything uploaded to xAI storage, with size, purpose and expiry (delete).
- **Batches** — batch inference jobs, with per-request pending/succeeded/errored/cancelled counts.
- **API keys** — full lifecycle on your team's keys: create with model and endpoint scopes plus QPS/QPM/TPM limits, rename, enable/disable, rotate the secret, delete.
- **Audit events** — the team audit log, newest first, paged until it runs out or the 4,000 most recent events are in. A longer log ends with a row saying older events were left behind, so nothing goes missing quietly.

## Credentials

xAI splits its API across **two hosts with two different keys**, and this plugin asks for both.

**API Key** (required) — [console.x.ai](https://console.x.ai) → **API Keys**. This is the `xai-…` key for `https://api.x.ai`. Models, voices, files, batches and the whole Speech tab run on it.

**Management Key** (optional) — [console.x.ai](https://console.x.ai) → **Settings** → **Management Keys**. Your account needs the _Management Keys_ read + write permission. This is a **different key for a different host**, `https://management-api.x.ai`.

Without the management key, everything on the inference key keeps working. What you lose is:

- the **API keys** list (it comes back empty rather than erroring),
- the **audit log**,
- **cost collection and the spend chart** — the account will report that billing needs a management key, with a link to the page to create one.

You never have to find your team id. The plugin discovers it from `GET /auth/management-keys/validation` when a management key is present, and falls back to `GET /v1/api-key` otherwise.

![xAI Add-account form showing the required API Key field and the optional Management Key field, with its description explaining what breaks without it](https://agent-assets.infrawrench.com/docs/screenshots/plugins/xai-add-account.png)

## The Speech tab

Open any voice — built-in or custom — and you get a **Speech** tab with both halves wired up. Models that declare audio modalities get the tab too.

- **Synthesize** posts to `POST /v1/tts`. The voice picker is filled from `GET /v1/tts/voices` plus your own custom voices, so the built-ins (Eve, Ara, Leo, Rex, Sal) and anything you have cloned appear side by side. Opening a voice preselects it. The language picker covers every BCP-47 code xAI documents, plus **Auto-detect**.
- **Transcribe** posts to `POST /v1/stt` with speaker diarization on, and returns word-level timings with per-word confidence.

![xAI Speech tab on the Eve voice, with the voice picker open showing built-in and custom voices, and a transcript with word timings and speaker labels below](https://agent-assets.infrawrench.com/docs/screenshots/plugins/xai-speech.png)

## Costs and metrics

With a management key attached, spend is collected from `POST /v1/billing/teams/{team_id}/usage` — a real analytics query, asked for as a daily USD sum grouped by line-item description. That gives you a per-service daily breakdown on the cost page, and a spend chart on each model's **Metrics** tab.

Prepaid balance and invoices live on the same host if you need to reconcile against a statement.

## Tips & limits

- **Synthesis is capped at 15,000 characters** per request, and the character counter enforces it before the call goes out.
- **Text-to-speech returns JSON, not audio bytes.** xAI wraps base64 audio in a JSON envelope alongside `content_type` and `duration`, unlike OpenAI and Groq. The plugin unwraps it; you just get a player. MP3 is requested explicitly so the clip plays in the browser.
- **Speech tags work.** `[pause]`, `[laugh]`, `[breath]` and wrapping styles like `<whisper>`, `<slow>` and `<sing-song>` are passed straight through to the model.
- **Transcription accepts up to 500 MB upstream, but the app caps uploads at 25 MB.** A test clip is a sentence or two; anything longer belongs in xAI's own streaming endpoint.
- **Your recording's container is forwarded as-is.** xAI auto-detects WAV, MP3, OGG, Opus, FLAC, AAC, MP4, M4A and MKV from the file header, so nothing is transcoded on the way out — whatever your browser recorded is what xAI receives.
- **Model prices are in USD cents per 100 million units** on the wire — tokens, generated images or search sources alike. The detail page converts them to dollars, per million tokens for the token rates and per item for the image and live-search rates, so you can compare at a glance.
- **Rotating an API key is not instant-revoke.** The old secret keeps working for 24 hours by default so in-flight deployments don't break. The app confirms before rotating and says so.
- **Custom voices are cloned from an audio clip**, which the app doesn't upload for you — create the voice in the xAI console or via `POST /v1/custom-voices`, then manage its metadata here.
