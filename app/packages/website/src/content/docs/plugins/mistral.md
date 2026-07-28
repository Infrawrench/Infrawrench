---
title: Mistral AI
description: Manage Mistral models, voices, files, fine-tuning and batch jobs, plus Voxtral transcription and speech synthesis from the Speech tab.
sidebar_order: 41
---

## What you can manage

- **Models** — base and fine-tuned checkpoints, with the full `capabilities` flag table and max context length
- **Voices** — TTS presets and workspace clones (rename, retag, delete clones)
- **Fine-tuning jobs** — status, datasets, trained tokens, and the resulting model id
- **Batch jobs** — progress counters and output/error files, with cancel and delete
- **Files** — fine-tuning datasets, batch JSONL, and OCR inputs (delete)
- **API keys** — Enterprise plans only, via the Admin API

## Credentials

Mistral console → **API Keys**. Paste the workspace key.

The **Admin API key** field is optional and separate. Mistral's Admin API lives on a different base (`api.mistral.ai/v1/admin`) with its own auth header, and it is **Enterprise-plan only**. Without it:

- the API-key listing is empty rather than broken, and
- cost collection is disabled with a message explaining why.

Everything else — models, voices, files, jobs, transcription, synthesis — works on the workspace key alone.

<insert [Mistral Add-account form showing the required API key field and the optional Admin API key field with its Enterprise-only description] here>

## The Speech tab

Open a voice (or any model) for a **Speech** tab:

- **Synthesize** posts JSON to `/v1/audio/speech` and asks for mp3. Mistral returns base64 audio inside a JSON envelope rather than raw bytes; the app decodes it for you. The voice picker is populated live from `GET /v1/audio/voices`, so workspace clones show up alongside the presets with their gender, languages, and description.
- **Transcribe** posts multipart to `/v1/audio/transcriptions` with **speaker diarisation enabled**, so the word table under the transcript carries speaker labels and the summary tells you how many speakers were detected.

<insert [Mistral Speech tab on a voice, showing the transcript with a per-speaker word table below] here>

## Costs

With an Admin API key attached, `GET /v1/admin/usage` feeds the cost dashboards. Mistral reports usage **monthly**, broken down by service (chat, completion, OCR, audio, fine-tuning, connectors), so rows are dated to the billing-period boundary and charts label the series as monthly-native.

## Tips & limits

- **Pagination is genuinely inconsistent** across Mistral's API and the plugin handles each case separately: `/models` takes no pagination parameters at all, files, batch jobs, and fine-tuning jobs use `page`/`page_size`, and voices and admin API keys use `limit`/`offset`.
- **Preset voices belong to Mistral** — they can be used but not renamed or deleted. Only workspace clones are editable.
- **API keys are listed, not created.** New keys are minted in the Mistral backoffice, which is the only place the plaintext value is ever shown. The plugin can revoke a key but deliberately does not create one.
- Uploads through the Speech tab are capped at 25 MB. The transcription API itself accepts far longer recordings — use a file id or URL through the API directly for those.
- OCR is available at `POST /v1/ocr` but is a one-shot action rather than a listable resource, so it has no resource type here.
