---
title: Groq
description: Browse the GroqCloud model catalogue, batches, files, and LoRA adapters, and run Whisper transcription and Orpheus speech synthesis from the Speech tab.
sidebar_order: 40
---

## What you can manage

- **Models** — the live GroqCloud catalogue, with context window, max completion tokens, and whether the model is still active
- **Fine-tunings** — LoRA adapters registered against a supported base model (create and delete)
- **Batches** — asynchronous batch inference jobs, with cancel
- **Files** — batch JSONL and adapter uploads (delete)

## Credentials

Groq console → **API Keys** → **Create API Key**. Paste the `gsk_…` value.

Groq has a single key type. There is no separate admin or management key, so one field is all this plugin asks for.

![Groq Add-account form with the single API key field and the "Create an API key" help link](https://agent-assets.infrawrench.com/docs/screenshots/plugins/groq-add-account.png)

## The Speech tab

Open any model and you get a **Speech** tab with both halves wired up:

- **Synthesize** posts to `/openai/v1/audio/speech` using Canopy Labs Orpheus — `canopylabs/orpheus-v1-english` and `canopylabs/orpheus-arabic-saudi`. Twelve voices are offered (Autumn, Diana, Hannah, Austin, Daniel, Troy in English; Abdullah, Fahad, Sultan, Lulwa, Noura, Aisha in Arabic). Picking an Arabic voice switches the model for you.
- **Transcribe** posts to `/openai/v1/audio/transcriptions` using `whisper-large-v3-turbo` or `whisper-large-v3`, with segment and word timings, and returns a confidence figure derived from Whisper's per-segment log-probabilities.

![Groq Speech tab showing the voice picker open with the Orpheus voice list, and a transcript with word timings below](https://agent-assets.infrawrench.com/docs/screenshots/plugins/groq-speech.png)

## Tips & limits

- **Transcription is billed with a 10-second floor.** A 2-second test clip still costs 10 seconds. The Speech tab says so above the recorder, and the result summary tells you when the floor kicked in.
- **Only the first audio track is transcribed** for files that carry several (dubbed video, for example).
- Uploads are capped at **25 MB** — the free-tier limit. Dev-tier keys accept 100 MB, but the app enforces the smaller number so a free-tier key never hits a surprise 413.
- **Synthesis is capped at 200 characters per request** and returns WAV. Orpheus offers no other container.
- **The model list is never hardcoded.** Groq deprecates models on a rolling schedule, so every picker in the app is populated from `GET /openai/v1/models` at load time. The retired `distil-whisper-large-v3-en` and `playai-tts` models are therefore never offered.
- Fine-tuning uses a **different API base** (`api.groq.com/v1`, with no `/openai` segment). The plugin handles both; you never see it. Groq registers adapters rather than training them — bring your own LoRA and point the form at the uploaded file. Self-serve currently covers `llama-3.1-8b-instant`.
- **There is no usage, cost, or API-key management API.** Spend, rate-limit history, and key rotation live in the Groq console only, and the model detail page links straight there rather than showing an empty chart.
