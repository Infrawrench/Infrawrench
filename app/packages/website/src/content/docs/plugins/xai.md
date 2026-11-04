---
title: xAI
description: Browse Grok models, files, batches, skills and voices, manage collections, team API keys, spending limits and invoices, read the audit log, and run Grok speech synthesis and transcription from the Speech tab.
sidebar_order: 35
---

## What you can manage

- **Models**: every model your key can call, in one list: chat and vision, image generation, video generation, and embedding models. Each shows its full price sheet, including cached-prompt and long-context rates and, for image models, prices per quality and resolution. Language models also list the `reasoning_effort` values they accept and their default.
- **Voices**: xAI's built-in voices _and_ any custom voices your team has cloned, in one list. You can edit and delete custom voices. Built-ins are read-only.
- **Files**: anything uploaded to xAI storage, with size, purpose and expiry. **Create public URL** gives a file a permanent link anyone can open (it expires with the file, if the file has an expiry). **Revoke public URL** removes the link and keeps the file. Delete.
- **Batches**: batch inference jobs, with pending, succeeded, errored and cancelled counts and a table of the first 100 requests with their state, model and timing. Create an empty named batch (then add requests from your code), and **Cancel batch** while requests are still pending.
- **Skills**: hosted skill bundles, with the name and description from their `SKILL.md` and their versions (delete). Upload new skills from your code as a zip.
- **Collections**: managed vector collections for retrieval, with their embedding model, chunking strategy, metadata fields and document count. Create one with an embedding model picked from a list and optional token chunking, rename it or change its description, or delete it. Needs the management key.
- **Collection documents**: every file indexed into every collection, with its processing status, size, metadata fields and last-indexed time. Add an uploaded file to a collection by picking both from lists, **Re-index** a document, or remove it from its collection (the file itself stays). Needs the management key.
- **API keys**: your team's keys. Create with model and endpoint scopes plus QPS, QPM and TPM limits, rename, enable or disable, rotate the secret, delete.
- **Invoices**: monthly and prepaid top-up invoices from the last two years, with status, subtotal, tax, total and every line item. Read-only. Needs the management key.
- **Spending limit**: the team's postpaid monthly spending limit, the hard limit xAI sets from it, and this billing period's running total and prepaid credit usage with line items. You can edit the monthly limit. Set it to 0 to limit the team to prepaid credit. Needs the management key.
- **Audit events**: the team audit log, newest first, up to the 4,000 most recent events. If there are more, a final row tells you older events were left out.

## Connect your account

xAI uses **two different keys**, and this plugin asks for both.

**API Key** (required): from [console.x.ai](https://console.x.ai) > **API Keys**. It's the `xai-…` key. Models, voices, files, batches and the whole Speech tab use it.

**Management Key** (optional): from [console.x.ai](https://console.x.ai) > **Settings** > **Management Keys**. Your account needs the _Management Keys_ read and write permission.

Without the management key, everything else keeps working. You lose:

- the **API keys** list (it shows empty instead of an error),
- the **audit log**,
- **collections and collection documents** (both lists show empty),
- **invoices, the spending limit and prepaid credit tracking**,
- **costs and the spend chart**. The account tells you billing needs a management key, with a link to create one.

You never need to find your team id. Infrawrench finds it from your keys.

![xAI Add-account form showing the required API Key field and the optional Management Key field, with its description explaining what breaks without it](https://agent-assets.infrawrench.com/docs-screenshots/plugins/xai/add-account.png)

## Test speech

Open any voice, built-in or custom, to get a **Speech** tab with both halves. Models that support audio get the tab too.

- **Synthesize**: the voice picker lists the built-ins (Eve, Ara, Leo, Rex, Sal) and anything you've cloned, side by side. Opening a voice picks it for you. The language picker covers every language code xAI documents, plus **Auto-detect**.
- **Transcribe**: speaker labels are on, and you get word-level timings with per-word confidence.

![xAI Speech tab on the Eve voice, with the voice picker open showing built-in and custom voices, and a transcript with word timings and speaker labels below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/xai/speech-tab-eve.png)

## Costs and metrics

With a management key added, you get daily spend in USD broken down by line item on the Costs page, plus spend charts on two **Metrics** tabs:

- each **model** charts its own spend, and
- the **spending limit** charts the whole team's spend next to the limit, with the five costliest line items shown beside the total.

Ranges of two days or less are hourly, longer ones daily.

The management key also turns on **prepaid credit tracking**: your remaining prepaid balance for the current billing period, so you're warned before credit runs out and the API stops answering. A team with no prepaid credit shows no balance rather than zero. Invoices and the spending limit are listed as resources (see above) for checking against a statement.

## Tips & limits

- **Synthesis is capped at 15,000 characters** per request. The character counter stops you before you go over.
- **Speech tags work.** `[pause]`, `[laugh]`, `[breath]` and styles like `<whisper>`, `<slow>` and `<sing-song>` are passed straight to the model.
- **Transcription uploads are capped at 25 MB in the app**, even though xAI accepts up to 500 MB. A test clip is a sentence or two. Use xAI's own streaming endpoint for anything longer.
- **Your recording is sent as is.** xAI detects WAV, MP3, OGG, Opus, FLAC, AAC, MP4, M4A and MKV on its own, so nothing is converted.
- **Prices are shown in dollars**, per million tokens for token rates and per item for image and live-search rates, so you can compare at a glance.
- **Rotating an API key doesn't revoke the old one straight away.** The old secret keeps working for 24 hours by default so running deployments don't break. The app says so and asks you to confirm before rotating.
- **Billing amounts are shown in dollars**, with prepaid credit as a negative amount.
- **Public file URLs need no sign-in.** Anyone with the link can download the file until you revoke it or the file expires. A team can have at most 1,000 active public URLs.
- **Custom voices are cloned from an audio clip**, which you can't upload here. Create the voice in the xAI console or with `POST /v1/custom-voices`, then manage it here.
