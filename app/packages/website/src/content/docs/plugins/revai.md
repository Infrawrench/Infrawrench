---
title: Rev AI
description: Rev AI transcription jobs, custom vocabularies, language identification, sentiment, topic and forced-alignment jobs, and account balances on either deployment, with a Speech tab that submits and polls a clip in one step.
sidebar_order: 47
---

## What you can manage

- **Account**: the developer account behind the token, with email, deployment, HIPAA status and the USD balances (free, purchased, invoiced, total). Read-only. This is where the Speech tab lives.
- **Transcription jobs**: speech-to-text jobs with status, transcriber, language, media name, duration and auto-delete window. Each job shows its transcript (delete).
- **Custom vocabularies**: saved phrase lists a job can use through `custom_vocabulary_id` (create, delete).
- **Language identification jobs**: find the most likely language in a piece of media. Create one from a public media URL (optionally marked as multilingual). The detail page shows the top language and every candidate's confidence (delete).
- **Sentiment analysis jobs**: score each statement of a transcript as positive, negative or neutral. Create one by picking a transcribed job from the list, and every statement keeps its timestamp. The detail page counts each sentiment and lists the statements (delete).
- **Topic extraction jobs**: the main topics of a transcript, with a score and the statements behind each. Create one the same way, by picking a transcribed job (delete).
- **Forced alignment jobs**: precise word timings for a transcript you already have. Create one from a public media URL, the spoken words and the language (English, Spanish or French). The detail page lists every word with its start and end time (delete).

## Connect your account

**Access Token** (required): get it from the Rev AI dashboard's [Access Token](https://www.rev.ai/access-token) page. It's shown once, and making a new one cancels the old one. One token covers jobs, transcripts, custom vocabularies and the account balance. There's no separate admin key.

**Deployment** (required, defaults to US): `us` or `eu` (Frankfurt). This decides what you can see, as explained below.

![Rev AI Add-account form showing the access token field and the US / EU deployment picker](https://agent-assets.infrawrench.com/docs-screenshots/plugins/revai/add-account.png)

## Transcribe a clip

Open the account and go to the **Speech** tab. It does transcription only. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

One press submits your clip, waits up to two minutes and shows the transcript. The **Transcriber** picker offers three automatic tiers:

- **Machine**: the default.
- **Low cost**: cheaper, lower accuracy. **Deprecated**: Rev AI is retiring it in July 2026 and recommends Machine.
- **Fusion**: higher accuracy, better on rare words. **Deprecated**: Rev AI is retiring it in August 2026.

Both deprecated tiers stay in the picker, labelled as such, until Rev AI stops accepting them.

**Human** transcription isn't offered here. A human job takes hours and is billed at human rates as soon as it's accepted, so it would time out in this panel after you'd already paid. Order human transcription through Rev AI directly.

"Reverb", "Reverb Turbo" and "Whisper" are marketing names for the engines behind these tiers, not values Rev AI accepts, so they aren't in the picker.

<insert [Rev AI Speech tab on the account, with the Transcriber picker open showing Machine, Low cost and Fusion] here>

## Metrics

The **Account** has a **Metrics** tab charting, per day: jobs submitted, failed jobs, audio minutes (split by transcriber when you use more than one, since they bill at different rates), streaming minutes if the account streams, and the average time from submission to transcript. These are counted from your jobs over the last 30 days, up to 5,000 jobs per range.

## Tips & limits

- **Jobs are kept for 30 days.** Every job list, transcription and the others, is a rolling month, not a full history.
- **Deployments don't share data.** A job submitted to US is invisible from EU and the other way round, so the deployment you pick decides what you see.
- **The EU deployment has no saved custom vocabularies and no human transcription.** You can still pass phrases with each job there, but the vocabularies section is US-only.
- **Only language identification runs on EU.** Sentiment, topic and alignment jobs are US-only, so those lists stay empty on an EU account.
- **Sentiment and topic jobs are English-only**, and you can only pick transcribed jobs from the last 30 days as their source.
- **Human transcription can't be ordered from the Speech tab.** Jobs you submit through Rev AI's own API still show up in the Transcription Jobs list, so read the result there.
- **The Speech tab caps clips at 25 MB**, well below Rev AI's own limit (2 GB and 17 hours). Send anything larger through Rev AI's API directly.
- **The seconds balance isn't shown**, since Rev AI always reports it as 0 and it would look like you're out of credit. The USD balances are the real numbers.
- **A blank field on a job usually means "not set"**, not "failed to load".
- **If you script against the same API**: the transcript URL needs an explicit `Accept` header (`*/*` gets a `406`), and the vocabulary status is `complete`, not `completed`.
