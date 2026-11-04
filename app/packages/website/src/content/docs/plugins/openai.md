---
title: OpenAI
description: Models, fine-tuning, batches, files, vector stores, containers and evals, plus organization projects, members, service accounts, rate limits, spend limits and alerts, keys and real spend, with a Speech tab for text-to-speech and transcription.
sidebar_order: 30
---

Use this plugin to manage both sides of your OpenAI account: the project work your `sk-proj-` key can reach, and the organization settings that only an admin key can reach. If you've only added one key, the app tells you which half you're missing.

## What you can manage

- **Models**: every model your key can call, base and fine-tuned. Each has a **Speech support** panel saying whether it can synthesize, transcribe, or neither. You can delete fine-tuned snapshots, not base models.
- **Fine-tuning jobs**: start a run from a training file and a base model, then pause, resume or cancel it while it runs.
- **Batches**: create a batch from an uploaded JSONL file, watch the request counters, and cancel it. Batches can't be deleted.
- **Files**: fine-tuning datasets, batch inputs and outputs, and file-search sources (delete).
- **Vector stores**: the collections behind the `file_search` tool (create, rename, delete), with a chart of file search calls made against each one (admin key).
- **Containers**: the sandboxes Code Interpreter runs in (create, delete). They expire after sitting idle and bill per session.
- **Evals**: evaluation definitions with their data source and graders (rename, delete).
- **Projects**: the billing and rate-limit boundary. Create one (with an optional data residency region), rename or archive it. Each has a cost and usage chart and a **Logs** tab showing its audit log. Admin key only.
- **Project members**: who can use each project, as `owner` or `member`. Add an existing organization member from a picker, change their role, or remove them. Admin key only.
- **Project service accounts**: the non-human identities that own project keys. Rename one, switch it between `member` and `owner`, mint another API key with **Get credentials** (shown once), or delete it, which revokes its keys. A **Logs** tab shows what it did. Admin key only.
- **Project rate limits**: each project's per-model limits, such as requests and tokens per minute, plus images, audio, daily requests and batch input tokens where the model has them. Edit them to hold a project below the organization's limit. Listed under each project. Admin key only.
- **Project API keys**: list and revoke (not create), with expiry, last use, a per-key usage chart and a **Logs** tab. Admin key only.
- **Spend limits**: hard monthly caps in US dollars for the whole organization or one project. Once spend hits the cap, requests are refused. Create, change the amount, or delete. Admin key only.
- **Spend alerts**: emails sent when monthly spend for the organization or a project crosses a threshold. Pick the scope, set the amount, recipients and an optional subject prefix, and edit them later. Admin key only.
- **Organization members**: change roles between `owner` and `reader`, or remove someone. Each member has a usage chart and a **Logs** tab. Admin key only.
- **Invites**: send and revoke. Admin key only.
- **Admin API keys**: every `sk-admin-` key with its owner, expiry and last use (revoke). Create new admin keys in the OpenAI dashboard. Admin key only.

## Connect your account

You need **two keys** to cover everything. They aren't interchangeable: each one gets a `403` on the other's endpoints.

**API Key** (required): get it from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). It's a project key starting `sk-` or `sk-proj-`. It covers models, fine-tuning, batches, files, vector stores, containers, evals and the whole Speech tab.

**Admin API Key** (optional): get it from [Settings > Organization > Admin keys](https://platform.openai.com/settings/organization/admin-keys). It starts `sk-admin-`, and only an organization owner can create one. Adding it gives you:

- **Projects** and everything inside them (members, service accounts, rate limits, API keys), **spend limits**, **spend alerts**, **organization members**, **invites** and **admin API keys**. Without it, these lists show as unavailable, not broken.
- The **usage charts** on models, projects, project API keys, organization members and vector stores, and the **Logs** tabs.
- **Cost tracking**. Without the admin key it's turned off, with a message saying why.

![OpenAI Add-account form showing the required API Key field and the optional Admin API Key field, with the description explaining what the admin key unlocks](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openai/add-account.png)

## Test speech

Every model has a **Speech** tab. Both halves share one model picker. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

- **Synthesize** returns mp3. You can pick from ten voices: Alloy, Ash, Ballad, Coral, Echo, Sage, Shimmer, Verse, Marin and Cedar. The older `fable`, `onyx` and `nova` voices aren't listed.
- **Transcribe** offers `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-transcribe`, `whisper-1` and `gpt-4o-transcribe-diarize`.

If you hit Synthesize on a model that can't do audio, the app uses `gpt-4o-mini-tts` instead. Transcription works the same way in reverse.

![OpenAI Speech tab on a model, with the voice picker open showing the ten built-in voices and a synthesized clip in the player below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/openai/speech-tab-voice-picker.png)

## See costs and usage

With an admin key added, you see real spend by day, split by line item and tagged with the project. Up to a year of history is available. The last three days can change, since OpenAI revises them.

Models, projects, project API keys and organization members each have a **Metrics** tab. It charts input, cached input and output tokens and request counts, plus cache write and audio tokens when there are any. Projects also show their daily cost.

The tab also shows these charts when there's data in the selected range:

- embeddings and moderations input tokens and requests,
- images generated and image requests,
- speech characters, transcribed audio seconds and their request counts,
- web search calls and file search calls,
- for projects only, Code Interpreter sessions and vector store storage in bytes.

Vector stores have their own **Metrics** tab with the file search calls made against them.

## Read the audit log

Projects, organization members, project service accounts and project API keys each have a **Logs** tab:

- a project shows every event inside it,
- a member or service account shows the events they performed,
- an API key shows the events performed on it (creation, scope changes, deletion).

Each line shows the time, event type, who did it, from which IP, and what it was done to. You see the newest 100 events.

An organization owner has to turn on audit logging once under **Settings > Organization > Data controls**. It can't be turned off again, and it records nothing from before it was enabled.

## Tips & limits

- **Synthesis is capped at 4,096 characters** per request, and transcription uploads at 25 MB.
- **Word timings only come from `whisper-1`.** The gpt-4o transcribe models don't return timestamps, so the word table appears for whisper-1 and for the diarize model's segments only.
- **Speaker labels only come from `gpt-4o-transcribe-diarize`.**
- **The legacy `tts-1` and `tts-1-hd` models don't accept tone instructions.** The app leaves the instructions box out for those two.
- **The default TTS model is pinned** to `gpt-4o-mini-tts-2025-12-15`, so the same text sounds the same from one run to the next.
- **You can't create project API keys here.** Use the project's **Get credentials** action instead: it creates a service account in the project and gives you its key. A key owned by a user has to be made in the OpenAI dashboard.
- **Project rate limits can only go down.** Each project is capped at the organization's own limit for the model, which depends on your usage tier. Fields you leave blank in the edit form stay as they are.
- **Spend limits block, spend alerts don't.** A limit refuses requests once reached; an alert only sends an email. Enter amounts in dollars. OpenAI only supports USD per calendar month.
- **If you delete the admin key this account uses**, the admin sections stop working until you paste a new one.
- **Projects are archived, never deleted.** Archived projects still count in usage and cost reports, so they stay visible here.
- **Cost and usage data comes in 1-day buckets only.**
