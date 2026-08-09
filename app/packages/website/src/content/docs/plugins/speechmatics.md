---
title: Speechmatics
description: Batch transcription jobs on a regional endpoint, plus workspace projects and API keys through the Management API, and a Speech tab that transcribes in one request.
sidebar_order: 45
---

## What you can manage

- **Account** — one per added account, always present. It shows the region and batch endpoint, a 30-day usage summary read from `GET /v2/usage`, and the language packs the batch engine currently offers — and it is where the [Speech tab](#the-speech-tab) lives. Jobs are purged after seven days and projects need a management token, so this is the only resource guaranteed to exist.
- **Transcription jobs** — the batch jobs on this account's region, with status, audio file, duration, language pack and model. Each job's detail page carries a copyable transcript URL. Delete a job to purge it early.
- **Projects** — the isolation boundary for API keys, transcripts and usage. Read-only, and only visible with a management token.
- **API keys** — the keys issued inside a project, as metadata (delete). Only visible with a management token.

## Credentials

Three fields, because Speechmatics splits its API across two hosts and three regions.

**API Key** (required) — Speechmatics Portal → **Manage workspace › API keys**. This is the batch key: it lists and submits transcription jobs and drives the Speech tab. It cannot read the Management API.

**Region** (required, defaults to `eu1`) — `eu1`, `us1` or `au1`. Pick the region your API key was created in.

**Management Token** (optional) — Portal → **Manage workspace › Management tokens**. A **different credential on a different host**: the Management API is served from `https://mp.api.speechmatics.com/v1`, not the regional ASR endpoint. Without it the **Projects** and **API Keys** lists stay empty; transcription jobs, metrics and the Speech tab are entirely unaffected.

<insert [Speechmatics Add-account form showing the API key, the region picker with eu1/us1/au1, and the optional Management Token field] here>

## The Speech tab

Open the **Account** resource for a **Speech** tab. It is transcription only. See [Speech testing](../features/speech-testing.md) for the panel in general.

The same tab is offered on an individual job, where it doubles as "run this one again with different settings" — but jobs are purged after seven days, so the account is the copy that is always there.

The happy path is a single request: the clip is submitted as a batch job with `?wait=60`, so the transcript comes back in the same response. Longer clips fall back to polling, capped at two minutes total.

Language packs and models are read live from `GET /v1/discovery/features` on your region — which is unauthenticated, so the pickers are populated even before the key is validated. The default model is **enhanced**.

<insert [Speechmatics Speech tab on the Account resource, with the language-pack picker populated from discovery and a completed transcript] here>

## Metrics

The account and each job get a **Metrics** tab over the last 30 days charting **transcription hours** and **billable jobs**, read from `GET /v2/usage`. The endpoint is account-wide rather than per-job, so both tabs show the same series. The window is split into at most ten buckets, each fetched as its own `since`/`until` range, because the usage endpoint takes calendar dates rather than a granularity parameter.

## Tips & limits

- **Jobs are region-scoped and not portable.** A job created against `eu1` is invisible from `us1` and `au1`, and every request about a job has to go to the same region it was created on. The account's region credential therefore decides which jobs this plugin can see at all — if a job is missing, check the region before checking the key.
- **`au1` is batch-only.**
- **Audio, transcripts and job config are retained for 7 days.** After that the transcript endpoints return `404` and the job reports status `expired`. The Speech tab's subtitle says so, and so does the job list. The **Account** resource does not expire with them, which is why the Speech tab lives there.
- **Deleting a running job needs force.** The plugin always sends `?force=true`, because without it a still-running job answers `423 Locked` instead of being removed — and by that point you have already confirmed the deletion.
- **Uploads are capped at 1 GB** by Speechmatics, and at 25 MB in the Speech tab, because the clip travels base64-encoded inside a JSON request.
- **The transcript format is a query parameter, not an `Accept` header.** Append `?format=txt`, `?format=srt` or `?format=json-v2` to the transcript URL. The detail page shows the URL and says this next to it.
- **Melia-1 is multilingual only** — picking it forces the language to `multi`.
- **A `rejected` job was accepted and then failed to process.** It is a distinct state from a failed submission, and `GET /v2/jobs/{id}/log` usually explains why.
- **API keys are listed and deleted, never created.** The secret is only ever revealed once at creation in the Portal, so only metadata is shown here.
