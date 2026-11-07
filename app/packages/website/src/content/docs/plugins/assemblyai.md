---
title: AssemblyAI
description: Browse the account's transcripts, manage Voice Agent API agents, sessions and webhooks, browse the LLM Gateway catalogue, and run a full transcription from the Speech tab in one step.
sidebar_order: 44
---

Connect AssemblyAI to browse your transcripts, manage Voice Agent API agents and webhooks, see the LLM Gateway model catalogue, and test transcription from the Speech tab. AssemblyAI offers no API for API keys, usage, billing or team members, so those aren't shown.

## What you can manage

- **Account**: one per added account, always there. It shows which region the key uses and counts the newest 100 transcripts from the last 30 days. It's also where the [Speech tab](#the-speech-tab) lives, so you can use it on a brand-new account that has never transcribed anything.
- **Transcripts**: every speech-to-text job the key can see, with status, model, audio duration, detected language, overall confidence, word count and whether diarisation was on. Delete one to purge it early.
- **Voice agents**: saved agents for the Voice Agent API, with system prompt, voice, greeting, key terms, tools and any custom LLM. Create one with a name, one of AssemblyAI's sixteen documented voices, a system prompt, an optional greeting and key terms. You can later edit the name, voice, greeting or system prompt. Tools, a custom LLM and pre-connect requests are left as they are. Each agent has a **Metrics** tab charting sessions per day and session minutes. Delete to remove it.
- **Agent sessions**: the newest 10,000 realtime conversations, newest first, named after the agent it used, with status, duration, how it closed and, once complete, links to the recording, timeline and metadata. Those links expire quickly, so refresh the page for fresh ones. Delete a session to remove it.
- **Webhook subscriptions**: send `session.started`, `session.completed`, `call.connected`, `call.ended` and `call.failed` events to an HTTPS endpoint, for every agent or just one. Pick the events when you create it. Leave the signing secret blank and one is generated and shown **once**. Edit to change the URL, switch events on or off, disable the subscription, or rotate the secret (AssemblyAI only shows the secret's version afterwards).
- **LLM Gateway models**: the gateway's model catalogue with creator, context length, maximum completion tokens, supported parameters, regions, retirement date and list prices per million tokens. Read-only, and specific to your region.

## Connect your account

**API Key** (required): find it on the [API Keys](https://www.assemblyai.com/app/api-keys) page of the AssemblyAI dashboard. There's only one kind of key, and it both submits and reads transcripts. Keys are scoped to a project, so a transcript submitted with one project's key can't be read with another's.

**API Region** (optional, defaults to North America): the **EU** option (`api.eu.assemblyai.com`) keeps audio and transcripts inside the European Union.

![AssemblyAI Add-account form showing the API key field and the region picker with the Default and EU options](https://agent-assets.infrawrench.com/docs-screenshots/plugins/assemblyai/add-account.png)

## The Speech tab

Open the **Account** resource for a **Speech** tab. It's transcription only, since AssemblyAI has no speech synthesis. See [Speech testing](../features/speech-testing.md) for how the panel works.

You also get the tab on any individual transcript, which is handy for running it again with different settings.

One press uploads your clip, submits it and waits for the result. Punctuation, text formatting and speaker diarization are all on.

Pick one of two models:

- **Universal-3.5 Pro**: highest accuracy, 18 languages, keyterm prompts up to 1,000 terms. AssemblyAI's default.
- **Universal-2**: the broadest coverage at 99 languages, and what AssemblyAI falls back to when Universal-3.5 Pro can't serve a request.

![AssemblyAI Speech tab on the Account resource, with the model picker set to Universal-3.5 Pro and a completed transcript showing speaker labels](https://agent-assets.infrawrench.com/docs-screenshots/plugins/assemblyai/speech-tab-universal.png)

## Tips & limits

- **Transcripts are deleted after 30 days** by default, sooner if you set a shorter retention. The list only covers the last 30 days. Anything older is already gone from AssemblyAI. The **Account** resource stays, so the Speech tab is always available.
- **The Speech tab gives up after 120 seconds.** The API accepts files up to 2.2 GB, but this panel is for clips. Submit long recordings from the AssemblyAI dashboard and read them back from the Transcripts list here.
- **Uploads in the panel are capped at 25 MB.**
- **There's no usage or billing data.** The account and transcript pages have a **Recent activity** panel counting completed, failed and queued jobs among the newest 100 from the last 30 days. That's a job count, not billed usage. Check spend in the AssemblyAI dashboard.
- **The account Metrics tab charts transcripts**: submitted per day, failed, and the average turnaround (created to completed), for up to 2,000 jobs per range. There's no hours chart, since audio duration isn't available there. If your key can use the Voice Agent API, account-wide voice agent sessions and minutes are charted too.
- **Language codes use an underscored region** (`en_us`), not the hyphenated BCP-47 tag most other providers want. Picking **Auto-detect** turns on language detection instead of sending a code.
- **Regions don't share data.** An account set to EU won't see transcripts submitted through the default region, and the other way round. Pick the region your key already uses.
- **Rate-limit errors come back as `403`**, which looks the same as an auth failure.
- **Only the first audio track is transcribed** on media with several.
- **Voice agents use one region.** Agents, sessions and webhooks always come from `agents.assemblyai.com`, whichever region the account uses. The LLM Gateway catalogue does follow your region.
- **Voice agent usage is a session count, not billing.**
