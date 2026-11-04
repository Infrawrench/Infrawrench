---
title: Groq
description: Browse the GroqCloud model catalogue, batches, files, and LoRA adapters, chart per-model Prometheus metrics on Enterprise, and run Whisper transcription and Orpheus speech synthesis from the Speech tab.
sidebar_order: 40
---

Connect Groq to browse models, run batches and LoRA adapters, try speech and transcription, and chart model metrics on Enterprise.

## What you can manage

- **Models**: the current GroqCloud catalogue, with context window, max completion tokens, whether the model is still active, and a Metrics tab on the Enterprise tier
- **Fine-tunings**: LoRA adapters registered against a supported base model (create and delete)
- **Batches**: batch inference jobs (create from an uploaded file, cancel), with validation errors and metadata
- **Files**: batch JSONL and adapter uploads (delete)

## Connect your account

In the Groq console, go to **API Keys > Create API Key** and paste the `gsk_…` value.

Groq has only one key type, so that's the only field.

![Groq Add-account form with the single API key field and the "Create an API key" help link](https://agent-assets.infrawrench.com/docs-screenshots/plugins/groq/add-account.png)

## Try speech and transcription

Open any model to get a **Speech** tab:

- **Synthesize** turns text into speech with Canopy Labs Orpheus (`canopylabs/orpheus-v1-english` and `canopylabs/orpheus-arabic-saudi`). There are twelve voices: Autumn, Diana, Hannah, Austin, Daniel and Troy in English, and Abdullah, Fahad, Sultan, Lulwa, Noura and Aisha in Arabic. Picking an Arabic voice switches the model for you.
- **Transcribe** turns audio into text with `whisper-large-v3-turbo` or `whisper-large-v3`, with segment and word timings and a confidence figure.

![Groq Speech tab showing the voice picker open with the Orpheus voice list, and a transcript with word timings below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/groq/speech-tab-orpheus.png)

## Create a batch

**New Batch** asks for three things:

- **Input File**: any upload with purpose `batch`. Result files (`batch_output`) aren't offered. A batch file can hold up to 50,000 lines or 200 MB.
- **Endpoint**: chat completions, audio transcriptions or audio translations. Every line in the file goes there.
- **Completion Window**: 24 hours, 48 hours or 7 days. Longer windows finish more reliably when Groq is busy. Anything left at the deadline expires.

If validation fails, the batch detail page lists Groq's error messages under **Validation Errors**.

## Metrics (Enterprise)

Enterprise organizations get Prometheus-compatible metrics with the same API key. If your key has access, each model's **Metrics** tab charts the last 24 hours by default:

- requests per second, split by HTTP status code
- input and output tokens per second
- input and output tokens per request, p50 and p99
- queue latency p50 and p99, time to first token p50 and p99, and end-to-end latency p50 and p99
- prompt cache hit rate

On any other tier the tab stays empty. Checking costs you nothing.

<insert [Groq model Metrics tab on an Enterprise account, showing the requests per second and latency percentile charts for llama-3.1-8b-instant] here>

## Tips and limits

- **Transcription is billed for at least 10 seconds.** A 2-second test clip still costs 10 seconds. The Speech tab says so above the recorder, and the result tells you when the minimum applied.
- **Only the first audio track is transcribed** in files that have several (dubbed video, for example).
- **Uploads are capped at 25 MB**, the free-tier limit, even for Dev-tier keys that accept 100 MB.
- **Synthesis is capped at 200 characters per request** and returns WAV only.
- **Model pickers always show Groq's current models**, so retired ones like `distil-whisper-large-v3-en` and `playai-tts` aren't offered.
- **Fine-tuning registers adapters, it doesn't train them.** Bring your own LoRA and point the form at the uploaded file. Self-serve currently covers `llama-3.1-8b-instant`.
- **Costs and API keys aren't available here.** Check spend and rotate keys in the Groq console. The model detail page links straight there. Outside Enterprise, rate-limit history is console-only too.
