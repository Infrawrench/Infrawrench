---
title: AssemblyAI
description: Browse the account's transcripts, manage Voice Agent API agents, sessions and webhooks, browse the LLM Gateway catalogue, and run a full upload-submit-poll transcription from the Speech tab in one step.
sidebar_order: 44
---

AssemblyAI's transcription API is async-only and deliberately narrow: `GET /v2/transcript` is its single listing endpoint, and there is no REST surface for API keys, usage, billing or team members. The newer Voice Agent API (on `agents.assemblyai.com`) and the LLM Gateway add agents, their sessions and webhooks, and a model catalogue, which is the rest of this plugin's inventory.

## What you can manage

- **Account** — one per added account, always present. It shows which regional host the key talks to and counts the transcripts still inside the 90-day retention window, and it is where the [Speech tab](#the-speech-tab) lives. Because transcripts only exist once the key has been used, this is the resource that makes the plugin usable on a brand-new account.
- **Transcripts** — every speech-to-text job the key can see, with its status, the model that produced it, audio duration, detected language, overall confidence, word count and whether diarisation was on. Delete one to purge it early.
- **Voice agents** — saved agents for the Voice Agent API: system prompt, voice, greeting, key terms, tools and any custom LLM. Create one with a name, a voice picked from AssemblyAI's sixteen documented voices, a system prompt, an optional greeting and key terms. Edit the name, voice, greeting or system prompt later; tools, a custom LLM and pre-connect requests are left exactly as they are. Each agent has a **Metrics** tab charting sessions per day and session minutes, counted from its session history. Delete to remove it.
- **Agent sessions** — every realtime conversation, newest first, named after the agent it used, with status, duration, how it closed and, once complete, links to the recording, timeline and metadata. Those links are pre-signed and expire quickly, so refresh the page for fresh ones. Delete a session to remove it.
- **Webhook subscriptions** — deliver `session.started`, `session.completed`, `call.connected`, `call.ended` and `call.failed` events to an HTTPS endpoint, for every agent or just one. Pick the events when creating it; leave the signing secret blank and one is generated and shown **once**. Edit to change the URL, switch events on or off, disable the subscription, or rotate the secret (AssemblyAI only ever reports the secret's version).
- **LLM Gateway models** — the gateway's model catalogue with creator, context length, maximum completion tokens, supported parameters, regions, retirement date and list prices per million tokens. Read-only; it comes from the gateway host for your region.

## Credentials

**API Key** (required) — the AssemblyAI dashboard's [API Keys](https://www.assemblyai.com/app/api-keys) page. There is only one kind of key; the same key both submits and reads transcripts. Keys are scoped to a project, so a transcript submitted with one project's key cannot be read with another's.

**API Region** (optional, defaults to North America) — which host to talk to. The **EU** option (`api.eu.assemblyai.com`) keeps audio and transcripts inside the European Union.

![AssemblyAI Add-account form showing the API key field and the region picker with the Default and EU options](https://agent-assets.infrawrench.com/docs-screenshots/plugins/assemblyai/add-account.png)

## The Speech tab

Open the **Account** resource for a **Speech** tab. It is transcription only — AssemblyAI has no synthesis endpoint. See [Speech testing](../features/speech-testing.md) for the panel in general.

The same tab is offered on any individual transcript, where it doubles as "run this one again with different settings" — but the account is the copy that is always there, including on an account that has never transcribed anything.

One press runs the whole async lifecycle: `POST /v2/upload` with the raw bytes, `POST /v2/transcript` with the returned URL, then `GET /v2/transcript/{id}` every three seconds until it finishes. Punctuation, text formatting and speaker diarization are all on.

Two models are offered, which are the only two the v2 API still accepts:

- **Universal-3.5 Pro** — highest accuracy, 18 languages, keyterm prompts up to 1,000 terms. The first entry of AssemblyAI's own default model list.
- **Universal-2** — the broadest coverage at 99 languages, and what AssemblyAI falls back to when Universal-3.5 Pro cannot serve a request.

![AssemblyAI Speech tab on the Account resource, with the model picker set to Universal-3.5 Pro and a completed transcript showing speaker labels](https://agent-assets.infrawrench.com/docs-screenshots/plugins/assemblyai/speech-tab-universal.png)

## Tips & limits

- **Transcripts are deleted after 90 days.** The list is a rolling 90-day window, not a complete inventory of everything the account has ever transcribed — anything older is already gone from AssemblyAI's side. The **Account** resource does not expire with them, so the Speech tab is still there once it has.
- **The Speech tab gives up after 120 seconds.** The API accepts files up to 2.2 GB, but this panel is for clips: submit long recordings from the AssemblyAI dashboard and read them back from the Transcripts list here.
- **Uploads are capped at 25 MB** in the panel, because the clip travels base64-encoded inside a JSON request.
- **There is no usage, billing or quota API.** The account and transcript detail pages carry a **Recent activity** panel counting completed, failed and queued jobs inside the retention window — that is a job count, not billed usage, and it says so. Spend is dashboard-only.
- **The account Metrics tab is built from the transcript list.** It charts transcripts submitted per day, failed transcripts and the average turnaround (created to completed), read from `GET /v2/transcript` (at most 2,000 jobs per range, newest first). The list carries no audio duration, so there is no hours chart. When the key can use the Voice Agent API, account-wide voice agent sessions and minutes are charted alongside.
- **Language codes are ISO-639-1 with an underscored region** (`en_us`), not the hyphenated BCP-47 tag most other providers want. Picking **Auto-detect** sends `language_detection: true` instead of a code, because the two are mutually exclusive.
- **Regions do not share data.** An account pointed at EU will not see transcripts submitted through the default host, and vice versa. Pick the one your key already uses.
- **Rate-limit violations come back as `403`, not `429`** — indistinguishable from an auth failure at the transport layer. The background poller is deliberately kept well under any plausible ceiling so a `403` never has to be guessed at.
- **Only the first audio track is transcribed** on media that carries several.
- **Voice agents live on one host.** AssemblyAI documents only `agents.assemblyai.com` for the Voice Agent API, so agents, sessions and webhooks are read from there whichever region the account uses. The LLM Gateway catalogue does follow the region.
- **Voice agent usage is a session count, not billing.** The agent Metrics tab sums the session list, which is the only usage-shaped data the API offers.
