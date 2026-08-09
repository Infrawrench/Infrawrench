---
title: Rev AI
description: Rev AI transcription jobs, custom vocabularies and account balances on either deployment, with a Speech tab that submits and polls a clip in one step.
sidebar_order: 47
---

## What you can manage

- **Account** — the developer account behind the token: email, deployment, HIPAA status and the USD balances (free, purchased, invoiced, total). Read-only, and the home of the Speech tab.
- **Transcription jobs** — asynchronous speech-to-text jobs with status, transcriber, language, media name, duration and auto-delete window. Each job's transcript is fetched inline (delete).
- **Custom vocabularies** — saved phrase lists a job can reference by `custom_vocabulary_id` (create, delete).

## Credentials

**Access Token** (required) — the Rev AI dashboard's [Access Token](https://www.rev.ai/access-token) page. It is shown once, and regenerating it invalidates the old one. A single token covers jobs, transcripts, custom vocabularies and the account balance; there is no separate admin key.

**Deployment** (required, defaults to US) — `us` (the default host) or `eu` (Frankfurt). This is not cosmetic: see below.

![Rev AI Add-account form showing the access token field and the US / EU deployment picker](https://agent-assets.infrawrench.com/docs/screenshots/plugins/revai-add-account.png)

## The Speech tab

Open the account for a **Speech** tab. It is transcription only. See [Speech testing](../features/speech-testing.md) for the panel in general.

The clip is posted to `/jobs` as multipart, then polled for up to two minutes and the transcript fetched — all in one press. Four transcribers are offered, which are the whole documented enum:

- **Machine** — the default automatic tier
- **Low cost** — cheaper, lower accuracy
- **Fusion** — higher accuracy, better on rare words
- **Human** — human transcription, US deployment only

"Reverb", "Reverb Turbo" and "Whisper" are marketing names for the engines behind these, not valid API values, so they are deliberately absent from the picker — sending one is a rejected job.

![Rev AI Speech tab on the account, with the transcriber picker open showing Machine, Low cost, Fusion and Human](https://agent-assets.infrawrench.com/docs/screenshots/plugins/revai-speech.png)

## Tips & limits

- **Jobs are kept for 30 days.** `GET /jobs` only covers the last 30 days, so the Transcription Jobs list is a rolling month rather than a full history.
- **Deployments do not share data.** A job submitted to the US host is invisible from the EU host and vice versa, so the deployment you pick when adding the account decides what you can see.
- **The EU deployment has no saved custom vocabularies and no human transcription.** Frankfurt accepts phrases inline at submit time, but there is no `/vocabularies` collection there, so that section is US-only.
- **Human transcription will time out in the Speech tab.** It takes hours to come back. Submit it and read the result from the Jobs list instead.
- **The Speech tab caps clips at 25 MB**, well below what Rev AI itself accepts (2 GB and 17 hours). The panel sends audio base64-encoded inside a JSON request, and base64 inflates by a third — 25 MB is what survives that round trip. Send anything larger through Rev AI's own API directly.
- **`balance_seconds` is deprecated and always returns 0**, so it is deliberately not shown — displaying it would read as "out of credit" on a funded account. The USD balances are the live numbers.
- **The transcript URL needs an explicit `Accept` header.** Requesting it with `*/*` is rejected with a `406`.
- **Rev AI omits null properties entirely** rather than sending nulls, so a blank field on a job usually means "not set", not "failed to load".
- **The vocabulary status enum says `complete`, not `completed`** — worth knowing if you script against the same API.
