---
title: Google Gemini
description: The Gemini API on Google AI Studio. Models, tuned models, files, context caches, batches, File Search stores, custom voices and webhooks, plus speech synthesis and transcription.
sidebar_order: 32
---

Connect your Google AI Studio API key to manage your Gemini files, caches, batches, File Search stores, voices and webhooks, and to test speech in both directions.

This is the **AI Studio** Gemini API (`generativelanguage.googleapis.com`), not Vertex AI. If you want Vertex, service accounts and Google Cloud billing, use the [Google Cloud](./gcp.md) plugin instead.

## What you can manage

- **Models**: the base catalogue with input and output token limits, supported generation methods, sampling defaults, and whether the model emits reasoning tokens. Read-only, and where you'll find the Speech tab.
- **Tuned models**: models tuned from a base model on your own examples, with their hyperparameters and tuning timestamps. You can delete them.
- **Files**: anything uploaded to the Files API, with its state and expiry. You can delete them.
- **Context caches**: pre-tokenised prompt prefixes billed at the lower cache rate. You can edit the TTL. Everything else is fixed when the cache is created.
- **Batches**: asynchronous inference at half the interactive rate, with per-request counters. To create one, pick a model and an uploaded JSONL input file and give it a priority. You can rename or reprioritise it later, cancel it or delete it.
- **File Search stores**: managed RAG indexes you query with the `file_search` tool. Create one (optionally picking an embedding model from the list) or delete one.
- **File Search documents**: the documents inside a store. Import a file you've already uploaded into a store, with optional chunk size and overlap, or delete a document.
- **Custom voices**: text-to-speech voices designed from a description (Voice design) or replicated from a recording. Design a new one from a prompt with a name, gender and language, or delete one. Your custom voices also appear at the top of the Speech tab's voice picker.
- **Webhooks**: HTTPS endpoints Gemini notifies when a batch, a background interaction or a video generation finishes. Create one and pick its events, edit its name, URL, events and enabled state, send a test ping, rotate the signing secret with **Get credentials** (shown once), or delete it.

## Connect an account

There's one field. In Google AI Studio, click **Get API key** at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Keys start with `AIza`.

A Vertex AI service account or a Google Cloud OAuth credential won't work here. You need an AI Studio key.

![Gemini Add-account form with the single AI Studio API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gemini/add-account.png)

## Test speech

Open any model and go to the **Speech** tab. It lets you synthesize speech and transcribe audio. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

- **Synthesize** works with `gemini-3.8-flash-tts` (the default), `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview` or `gemini-2.5-pro-preview-tts`. Your custom voices are listed first, then all **thirty** prebuilt voices with Google's one-word style descriptions: Zephyr (bright), Puck (upbeat), Kore (firm), Enceladus (breathy), Sulafat (warm), and so on.
- **Transcribe** works with any multimodal Gemini model. The picker lists the TTS models first and then everything else.

The language picker starts on **Match the input text**, which is what you usually want. Pick a BCP-47 tag to force the output language.

![Gemini Speech tab with the voice picker open showing the thirty prebuilt voices and their style descriptors](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gemini/speech-tab-voice-picker.png)

## Tips and limits

- **No spend or quota charts.** The Gemini API has no billing, usage or quota API, so Infrawrench can't chart spend or remaining quota. The model page says so and links to AI Studio and the rate-limits page instead.
- **Uploaded files are deleted after 48 hours.** The Files list only covers the last two days. Storage is capped at 20 GB per project and 2 GB per file.
- **Audio clips in the Speech tab are capped at 14 MB.** Longer clips need to go through the Files API.
- **Browser recordings aren't on Google's list of audio formats.** Google lists WAV, MP3, AIFF, AAC, OGG and FLAC, but not WebM (Chrome, Edge, Firefox) or MP4 (Safari). They very probably work anyway, so Infrawrench sends your recording as is. Upload one of the six listed formats if you want a guarantee.
- **Deleting a File Search store deletes its documents too.**
- **Only a cache's TTL can be edited.** Everything else is fixed once the cache is created.
- **Tuning is effectively retired on this API.** Google says no Gemini API model supports fine-tuning any more. Existing tuned models are still listed and can be deleted, but you can't create new ones.
- **Webhook signing secrets are shown once.** Creating a webhook doesn't show its secret. Use **Get credentials** on it to rotate one and copy it. The previous secret keeps working for 24 hours. Gemini turns a webhook off by itself after repeated failed deliveries. Fix the endpoint and set its state back to `enabled`.
- **Custom voices expire after a year without use**, and each time you use one the expiry moves back. They show up on the [Expiry radar](../features/expiry-radar.md). A project can hold 200 stored voices. Replicated voices need consent audio, so you create them in AI Studio. Here you can list and delete them.
- **Imported File Search documents take a moment to index.** Right after an import you may see a pending placeholder, and the real document replaces it on the next refresh. The source file can expire from the Files API afterwards without affecting the document.
