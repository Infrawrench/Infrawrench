---
title: Cohere
description: Cohere's Command, Embed, Rerank and Transcribe models, plus the datasets, fine-tunes, embed jobs and batches in your account.
sidebar_order: 34
---

## What you can manage

- **Models** — every model the platform serves, with its endpoints, context length, feature flags, tokenizer URL and sampling defaults. Deprecated models stay in the list and are labelled as such. Read-only, and the home of the Speech tab.
- **Datasets** — uploaded training data and job inputs and outputs, with validation status, errors and warnings (delete).
- **Fine-tuned models** — custom models trained from a Cohere base model, with their hyperparameters and dataset (delete).
- **Embed jobs** — bulk embedding runs that write vectors into an output dataset (cancel).
- **Batches** — asynchronous batch inference over an uploaded dataset, with per-record success and failure counts (cancel).

Embed jobs and batches are cancelled, never deleted — Cohere has no delete endpoint for either.

## Credentials

One field. [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys).

Cohere issues two kinds of key: a **Trial** key (free, heavily rate-limited, not for production) and a **Production** key (paid, billed per token). Either works here and both see exactly the same models, datasets, fine-tunes, embed jobs and batches.

![Cohere Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cohere/add-account.png)

## The Speech tab

Cohere ships **transcription only** — there is no text-to-speech endpoint anywhere in the product — so the Speech tab on a model has one half. See [Speech testing](../features/speech-testing.md) for how it works generally.

Transcription runs on `cohere-transcribe-03-2026`. Language is **required** by the API, so pick the one spoken in the clip rather than hoping for auto-detection. Cohere returns plain text with no word-level timings, so there is no word table under the transcript.

![Cohere Speech tab on a model, showing the transcribe half with the required language picker](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cohere/speech-tab-transcribe.png)

## Tips & limits

- **You cannot record a clip in the browser and send it straight to Cohere.** The API accepts FLAC, MP3, MPEG, MPGA, OGG and WAV — not the WebM your browser records on Chrome, Edge and Firefox, nor the MP4 Safari records. Convert first and upload. The Speech tab therefore hides the recorder entirely and offers only upload, with the accepted formats listed next to it.
- **Uploads are capped at 25 MB.**
- **Datasets are deleted automatically 30 days after upload.** The dataset list is a rolling month, and the detail page says so.
- **There is no usage or billing API.** Token consumption is reported only per response, in each call's `meta.billed_units` — there is no aggregate query anywhere, so Infrawrench cannot chart Cohere spend. Every model page carries a **Usage & Billing** section that explains this and links to the Cohere dashboard instead of showing an empty chart.
- **There is no key-management API either.** `POST /v1/check-api-key` is the only key-related endpoint in the product, so keys can only be created, rotated or revoked in the dashboard.
- **Fine-tuning is filed under "Deprecated".** Cohere retired fine-tuning for command, command-light, command-r, classify and rerank in September 2025. The endpoints still answer, so existing fine-tunes remain listable and deletable — but this plugin deliberately offers no way to create a new one.
- **Row counts and sizes on a dataset are sums this plugin computes.** Cohere reports them per `dataset_parts` entry rather than at the top level.
- **Pagination is inconsistent by endpoint.** Datasets use `limit`/`offset`, batches and fine-tunes use `page_size`/`page_token`, and embed jobs document no query parameters at all — that list is simply everything.
