---
title: Speechmatics
description: Batch transcription jobs on a regional endpoint, plus workspace projects and API keys through the Management API, and a Speech tab that transcribes in one request and previews Speechmatics text to speech.
sidebar_order: 45
---

## What you can manage

- **Account**: one per added account, always there. It shows the region and batch endpoint, a 30-day usage summary, and the language packs Speechmatics currently offers. This is where the [Speech tab](#transcribe-a-clip) lives.
- **Transcription jobs**: the batch jobs in this account's region, with status, audio file, duration, language pack and model. Each job's detail page has a copyable transcript URL and a **Logs** tab with that job's log. Delete a job to remove it early.
- **Projects**: each project keeps its own API keys, transcripts and usage. Create one with a name and description, rename it, or delete it. Only visible with a management token.
- **API keys**: the keys issued inside a project. Create one by picking its project, the product it may use (batch, realtime or text to speech) and an optional client reference. The key value is shown **once**, when you create it. Delete a key to revoke it. Only visible with a management token.

## Connect your account

There are three fields.

**API Key** (required): in the Speechmatics Portal, go to **Manage workspace > API keys**. This key lists and submits transcription jobs and runs the Speech tab. It can't manage projects or keys.

**Region** (required, defaults to `eu1`): `eu1`, `us1` or `au1`. Pick the region your API key was created in.

**Management Token** (optional): in the Portal, go to **Manage workspace > Management tokens**. This is a separate credential. Without it, the **Projects** and **API Keys** lists stay empty. Transcription jobs, metrics and the Speech tab work either way.

Each management token has its own permissions, so grant the ones you need: **View projects** and **View API keys** to list, **Manage projects** to create, rename and delete projects, and **Create API key** and **Delete API keys** for the key actions. A token without **View projects** still lists keys, just without the project each one belongs to.

![Speechmatics Add-account form showing the API key, the region picker with eu1/us1/au1, and the optional Management Token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/speechmatics/add-account.png)

## Transcribe a clip

Open the **Account** and go to the **Speech** tab. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

The same tab appears on each job, so you can run that job again with different settings. Jobs disappear after seven days, though, so the account's tab is the one that's always there.

Short clips come back in one go. Longer ones are checked until they finish, for up to two minutes in total.

The language pack and model pickers list what Speechmatics offers in your region. The default model is **enhanced**.

### Preview text to speech

The **Synthesize** half uses Speechmatics' text-to-speech preview and plays back a 16 kHz WAV. You can pick from four voices: Sarah and Theo (UK English) and Megan and Jack (US English). The preview is free while it lasts, and it needs a key that's allowed to use text to speech. If the account's key is refused, create one from the **API Keys** list with **Product** set to **Text to speech**.

![Speechmatics Speech tab on the Account resource, with the language-pack picker populated from discovery and a completed transcript](https://agent-assets.infrawrench.com/docs-screenshots/plugins/speechmatics/speech-tab-language-packs.png)

## Metrics

The account and each job have a **Metrics** tab over the last 30 days, charting **transcription hours** and **billable jobs**. When your usage includes both, hours are also split by mode (batch or real-time) and by operating point (standard or enhanced), which is how Speechmatics prices them. Usage is account-wide, so both tabs show the same charts.

## Cost

Speechmatics accounts feed [cost graphs & budgets](../features/cloud-costs.md), broken down by **service**, meaning the model and mode Speechmatics prices: **Batch Standard**, **Batch Enhanced**, **Batch Melia 1**, **Real-time Standard** and **Real-time Enhanced**.

**These are list-price estimates, not billed amounts.** Speechmatics has no billing API, so Infrawrench multiplies your audio hours by the published per-hour rate for each model:

| Service            | Rate       |
| ------------------ | ---------- |
| Batch Melia 1      | $0.24 / hr |
| Batch Standard     | $0.45 / hr |
| Batch Enhanced     | $0.75 / hr |
| Real-time Standard | $0.45 / hr |
| Real-time Enhanced | $0.80 / hr |

Rates are the Pro-plan list prices from [speechmatics.com/pricing](https://www.speechmatics.com/pricing), checked August 2026.

### What the estimate leaves out

- **Volume discounts, so large accounts read high.** Speechmatics automatically discounts billable usage above **500 hours per month for each type of speech-to-text**, currently 20% off the hours beyond that, with more discount negotiated from 24,000 hours a year. Infrawrench prices every hour at the base rate, so once a line item passes 500 hours in a month, the chart shows more than you'll be invoiced.
- **The opt-in model-training discount (33% off) and sign-up credit**, which push your real bill lower.
- **Usage with no public rate**, such as alignment jobs and any model released after these rates were recorded. These are left out rather than guessed, so they under-report.
- **Enterprise contracts**, which are custom-priced. The list rates above aren't your rates.

Use the graph to see the shape of your spend, and the Speechmatics Portal for the invoice.

### Good to know

- **Costs use your API key**, not the management token. You don't need a management token for costs.
- **History goes back 90 days.**
- **Today's spend appears tomorrow**, since Speechmatics leaves out the current UTC day. The last two days can still change.
- **Temporary keys don't work.** A temporary key created with a `client_ref` only covers that client's jobs and gets a `403 Forbidden` for usage. If costs report that, replace the account's **API Key** with a long-lived one from **Manage workspace > API keys** in the Portal.
- There's no breakdown by region or by job, since an account covers one region and usage is account-wide.

![Cost graph for a Speechmatics account broken down by service, showing Batch Enhanced and Real-time Standard as separate series, with the estimated-cost notice visible](https://agent-assets.infrawrench.com/docs-screenshots/plugins/speechmatics/cost-graph.png)

## Tips & limits

- **Jobs belong to one region.** A job created in `eu1` is invisible from `us1` and `au1`, so the account's region decides which jobs you see. If a job is missing, check the region before the key.
- **`au1` is batch-only.**
- **Audio, transcripts and job settings are kept for 7 days.** After that, the transcript is gone and the job shows as `expired`. The Speech tab and the job list both say so. The **Account** doesn't expire, which is why the Speech tab lives there.
- **Deleting a running job stops it and removes it.**
- **Uploads are capped at 1 GB** by Speechmatics, and at 25 MB in the Speech tab.
- **Pick the transcript format with a query parameter.** Add `?format=txt`, `?format=srt` or `?format=json-v2` to the transcript URL. The detail page shows the URL with a note about this.
- **Melia-1 is multilingual only.** Picking it sets the language to `multi`.
- **A `rejected` job was accepted and then failed to process.** That's different from a failed submission. The job's Logs tab usually explains why.
- **A new API key is shown once**, when you create it. Copy it then. Listed keys only show their details.
- **Only a project's name can change after you create it.** Set the description when you create the project.
- **Deleting a project can be refused** with `403` while the workspace has outstanding payments.
- **Job logs expire with the job.** After seven days, the Logs tab says the log is gone instead of showing an error.
