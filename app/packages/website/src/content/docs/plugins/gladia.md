---
title: Gladia
description: Gladia pre-recorded transcription jobs, live streaming sessions and their results, with a Speech tab that uploads, submits and polls a clip in one step.
sidebar_order: 48
---

Connect Gladia to browse your transcription jobs and live sessions, read their transcripts, and test transcription on your own clips.

## What you can manage

- **Workspace**: your API key, shown as one resource with a summary of recent activity and the Speech tab. Read-only.
- **Transcriptions**: pre-recorded transcription jobs with status, model, file name, audio duration, **billed** time, processing time, detected languages and channel count. The full transcript is shown on the job. You can delete jobs.
- **Live sessions**: real-time streaming sessions with the same timings and transcript, plus the stream format each session used (encoding, sample rate, bit depth, channels). Sessions are opened by the app that does the streaming, so you can't create them here. Delete one to purge it.

## Connect an account

There's one field. In the Gladia dashboard at [app.gladia.io](https://app.gladia.io/), go to **Account > API Keys**. One key covers uploads, pre-recorded transcription and the job history, so there's no separate admin or usage key.

![Gladia Add-account form with the single API key field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gladia/add-account.png)

## Test transcription

Open the workspace and go to the **Speech** tab. It does transcription only. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

One click uploads your clip, starts a job and waits up to two minutes for the result. Speaker labels appear in the word table. You can pick from three models: **Solaria-1** (the default, 100+ languages), **Solaria-3** (latest generation, pre-recorded only) and **Solaria Fusion** (pre-recorded only).

![Gladia Speech tab on the workspace, showing the Solaria model picker and a diarised transcript with speaker labels](https://agent-assets.infrawrench.com/docs-screenshots/plugins/gladia/speech-tab-solaria.png)

## Metrics

The **Workspace** has a **Metrics** tab that charts, per day: pre-recorded transcriptions, failed transcriptions, billed minutes (split by model when you use more than one), the average processing time of finished jobs, and live sessions with their billed minutes. Gladia has no usage API, so these are counted from your job history (up to 2,000 jobs per list). Billed minutes are audio duration times distinct channels, summed over the history you still have, so treat them as a guide, not an invoice.

## Tips and limits

- **No usage or quota figures.** Gladia doesn't report usage, so the workspace's activity panel adds up your most recent jobs and sessions. That's a **minimum**, not a billing figure, and the panel says so. Infrawrench doesn't chart Gladia spend.
- **Billed time and audio duration are different numbers**, and every job shows both. Billed time is the one that costs money.
- **The Speech tab caps clips at 25 MB**, well below what Gladia itself accepts (135 minutes and 1,000 MB). Send anything larger through Gladia's own API.
- **The Speech tab gives up after two minutes.** Submit long recordings from Gladia's dashboard and read them back from the Transcriptions list here.
- **Lists show no total count**, because Gladia doesn't report one.
- **Deleted transcriptions and sessions may linger for a moment** before the next refresh clears them. You can't delete a session that is still streaming (`403`).
