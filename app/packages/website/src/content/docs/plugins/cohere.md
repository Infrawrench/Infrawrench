---
title: Cohere
description: Cohere's Command, Embed, Rerank and Transcribe models, plus the datasets, fine-tunes, embed jobs and batches in your account.
sidebar_order: 34
---

Connect Cohere to browse its models, run batches and embed jobs over your datasets, and test transcription.

## What you can manage

- **Models**: every model Cohere serves, with its endpoints, context length, feature flags, tokenizer URL and sampling defaults. Deprecated models stay in the list and are labelled. Read-only. Models are also where you find the Speech tab.
- **Datasets**: uploaded training data and job inputs and outputs, with validation status, errors and warnings (delete).
- **Fine-tuned models**: custom models trained from a Cohere base model, with their hyperparameters and dataset (delete).
- **Embed jobs**: bulk embedding runs that write vectors into an output dataset (create, cancel).
- **Batches**: batch inference over an uploaded dataset, with per-record success and failure counts (create, cancel).

You can cancel embed jobs and batches but not delete them. Cohere doesn't support deleting either.

## Start a batch or an embed job

Both run over a dataset you have already uploaded, so you pick from lists instead of typing IDs.

- **Batch**: a name, an input dataset and a model. You can only pick validated datasets of a batch input type (`batch-chat-input`, `batch-chat-v2-input`, `batch-openai-chat-input`, `batch-embed-v2-input`), and only chat and embed models Cohere hasn't deprecated.
- **Embed job**: an optional name, a validated `embed-input` dataset, an embed model, the input type (search document, search query, classification, clustering or image), the embedding type (`float` by default, or `int8`, `uint8`, `binary`, `ubinary` on v3 and newer models), and which end of an over-long input to truncate.

The output dataset appears on the job when it completes. Upload datasets in the Cohere dashboard.

<insert [Cohere create-batch form with the input dataset picker open, showing only validated batch input datasets] here>

## Connect your account

Paste one API key from [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys).

Cohere has two kinds of key: a **Trial** key (free, heavily rate-limited, not for production) and a **Production** key (paid, billed per token). Either works, and both see the same models, datasets, fine-tunes, embed jobs and batches.

![Cohere Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cohere/add-account.png)

## Test transcription in the Speech tab

Cohere offers **transcription only**, with no text-to-speech, so the Speech tab on a model has just the transcribe half. See [Speech testing](../features/speech-testing.md) for how the tab works in general.

1. Pick a model. `cohere-transcribe-03-2026` is the default. Cohere's Arabic specialist, `cohere-transcribe-arabic-07-2026` (Arabic in all major dialects, plus Arabic-accented English), is also in the list.
2. Pick the language spoken in the clip. Cohere requires it, so there is no auto-detection.
3. Upload your clip.

You get plain text back. Cohere doesn't return word-level timings, so there is no word table under the transcript.

![Cohere Speech tab on a model, showing the transcribe half with the required language picker](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cohere/speech-tab-transcribe.png)

## Tips & limits

- **You can't record a clip in the browser for Cohere.** Cohere accepts FLAC, MP3, MPEG, MPGA, OGG and WAV, not the WebM or MP4 your browser records. Convert your audio first and upload it. The Speech tab shows only the upload option, with the accepted formats listed.
- **Uploads are capped at 25 MB.**
- **Cohere deletes datasets 30 days after upload.** The dataset list only ever covers the last month.
- **No spend chart.** Cohere has no usage or billing API, so Infrawrench can't chart Cohere spend. Each model page has a **Usage & Billing** section that links to the Cohere dashboard instead.
- **Manage keys in the Cohere dashboard.** Keys can only be created, rotated or revoked there.
- **You can't create new fine-tunes.** Cohere retired fine-tuning for command, command-light, command-r, classify and rerank in September 2025. Existing fine-tunes are still listed and can be deleted.
