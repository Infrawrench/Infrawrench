---
title: Google Gemini
description: The Gemini API on Google AI Studio. Models, tuned models, files, context caches, batches, File Search stores, custom voices and webhooks, plus speech synthesis and transcription.
sidebar_order: 32
---

This is the **AI Studio** Gemini API (`generativelanguage.googleapis.com`), not Vertex AI. If you want Vertex, service accounts and Google Cloud billing, use the [Google Cloud](./gcp.md) plugin instead.

## What you can manage

- **Models**: the base catalogue with input and output token limits, supported generation methods, sampling defaults, and whether the model emits reasoning tokens. Read-only, and the home of the Speech tab.
- **Tuned models**: models tuned from a base model on your own examples, with their hyperparameters and tuning timestamps (delete).
- **Files**: anything uploaded to the Files API, with its state and expiry (delete).
- **Context caches**: pre-tokenised prompt prefixes billed at the reduced cache rate. The TTL is editable; everything else is fixed at creation.
- **Batches**: asynchronous inference at half the interactive rate, with per-request counters. Create one by picking a model and an uploaded JSONL input file, give it a priority, rename or reprioritise it later, cancel, delete.
- **File Search stores**: managed RAG indexes queried with the `file_search` tool (create with an optional embedding model picked from the live list, delete).
- **File Search documents**: the individual documents inside a store. Import an already-uploaded file into a store, with optional chunk size and overlap, or delete one.
- **Custom voices**: text-to-speech voices designed from a description (Voice design) or replicated from a recording. Design a new one from a prompt with a name, gender and language, or delete one. Every custom voice also appears at the top of the Speech tab's voice picker.
- **Webhooks**: HTTPS endpoints Gemini notifies when a batch, a background interaction or a video generation finishes. Create one with a picker of events, edit its name, URL, events and enabled state, send a test ping, rotate the signing secret with **Get credentials** (shown once), or delete it.

## Credentials

One field. Google AI Studio → **Get API key**, at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Keys start with `AIza` and are sent as the `x-goog-api-key` header.

This is deliberately _not_ a Vertex AI service account and not a Google Cloud OAuth credential — neither will authenticate against this host.

![Gemini Add-account form with the single AI Studio API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gemini/add-account.png)

## The Speech tab

Open any model for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** runs through the Interactions API on `gemini-3.8-flash-tts` (the default), `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview` or `gemini-2.5-pro-preview-tts`. Your custom voices are listed first, then all **thirty** prebuilt voices with Google's own one-word style descriptors — Zephyr (bright), Puck (upbeat), Kore (firm), Enceladus (breathy), Sulafat (warm), and so on. The 3.8 models return WAV directly; the older ones return raw 24 kHz mono PCM, which the plugin wraps in a WAV header so the player can play it.
- **Transcribe** sends the clip inline to `generateContent`, which means any multimodal Gemini model can do it — the picker lists the TTS models first and then everything else.

The language picker leads with **Match the input text**, which is the usual case; pinning a BCP-47 tag forces the output language.

![Gemini Speech tab with the voice picker open showing the thirty prebuilt voices and their style descriptors](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gemini/speech-tab-voice-picker.png)

## Tips & limits

- **There is no billing, usage or quota API — at all.** `generativelanguage.googleapis.com` exposes inference and storage and nothing else, so this plugin cannot chart spend or remaining quota. The model page says so and links to AI Studio and the rate-limits page rather than showing an empty chart. The only cost signal in the API is the per-response `usageMetadata` token count.
- **Uploaded files auto-delete after 48 hours.** The Files list is a rolling two-day window, not an archive. Storage caps at 20 GB per project and 2 GB per file.
- **Inline audio is capped at 14 MB** in the Speech tab. Gemini's inline request bodies max out at 20 MB total, and base64 inflates audio by a third, so 14 MB of raw audio is what fits with room for the JSON envelope. Longer clips go through the Files API.
- **Google's documented audio formats exclude what your browser records.** WAV, MP3, AIFF, AAC, OGG and FLAC are listed; WebM (Chrome, Edge, Firefox) and MP4 (Safari) are not. They very probably work anyway — Firebase AI Logic fronts this same endpoint and lists both — so the plugin forwards a recording untouched and lets you see a real result rather than refusing it client-side. Upload one of the six documented formats if you want a guarantee.
- **Batches are Operations-shaped, not a normal collection.** The list response is `operations[]`, and the actual batch payload lives in each entry's `metadata`. The plugin flattens it; you just see batches.
- **Deleting a File Search store deletes its documents with it.** Both File Search deletes are sent with `force=true`, because without it a store holding documents refuses the request — and by that point you have already confirmed the deletion.
- **Only a cache's TTL is editable.** Everything else about a context cache is fixed once created.
- **Tuning is effectively retired on this API.** Google's tuning guide says no Gemini API model supports fine-tuning any more; existing tuned models are still listed and deletable through the live discovery document's endpoints, but there is nothing new to create or share.
- **Webhook signing secrets are shown once.** Creating a webhook does not display its secret; use **Get credentials** on it to rotate one and copy it. The previous secret keeps working for 24 hours. Gemini disables a webhook on its own after repeated failed deliveries; fix the endpoint and set its state back to `enabled`.
- **Custom voices expire after a year without use**, and every synthesis with one pushes the expiry back. They show up on the [Expiry radar](../features/expiry-radar.md). A project can hold 200 stored voices. Replicated voices need consent audio, so they are created in AI Studio; this plugin lists and deletes them.
- **Imported File Search documents index in the background.** Right after an import you may see a pending placeholder; the real document replaces it on the next refresh. The source file can expire from the Files API afterwards without affecting the document.
