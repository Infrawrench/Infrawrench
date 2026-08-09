---
title: Deepgram
description: Manage Deepgram projects, API keys, members, invites and prepaid balances, chart usage, and round-trip audio through Nova transcription and Aura voices.
sidebar_order: 43
---

## What you can manage

- **Projects** — the workspace that owns everything else. Rename it, chart its usage, and run the Speech tab from it.
- **API keys** — create one with a scope, tags and an optional expiry, and delete it. The secret is shown **once**, on the create response.
- **Members** — the users with access to a project. Change a member's role between `member`, `admin` and `owner`, or remove them.
- **Invites** — send one to an email address with a scope, or revoke it. Invites are addressed by email rather than by an id.
- **Balances** — prepaid credit on the project. Read-only; top-ups happen in Deepgram's billing console.
- **Models** — the project's entitled speech-to-text models and Aura voices in one list. TTS entries carry the full voice metadata: accent, age, characteristics, use cases and a preview clip.

## Credentials

One field. Deepgram Console → your project's **Settings → API Keys**.

Deepgram has a single key type but **three scopes**, and the scope decides how much of this plugin works:

- a **member** key can transcribe and synthesize, but cannot list keys, members, invites or balances — those sections stay empty,
- an **admin** or **owner** key sees the whole project.

The secret is shown once at creation and cannot be retrieved afterwards, so if you no longer have it, create a replacement rather than hunting for the old one.

![Deepgram Add-account form with the API key field and its scope explanation](https://agent-assets.infrawrench.com/docs/screenshots/plugins/deepgram-add-account.png)

## The Speech tab

Open a project for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** posts to `POST /v1/speak` and returns mp3. The voice picker is filled from your project's own Aura entitlements, so you only ever see voices you can actually call.
- **Transcribe** posts the clip's **raw bytes** to `POST /v1/listen` with punctuation, smart formatting, diarisation and utterance segmentation all on — so the word table under the transcript carries speaker labels.

If the key cannot read the project's model catalogue, the tab explains that a member-scope key or better is needed instead of failing silently.

![Deepgram Speech tab on a project, with the Aura voice picker open and a diarised transcript with speaker labels below](https://agent-assets.infrawrench.com/docs/screenshots/plugins/deepgram-speech.png)

## Metrics

Projects get a **Metrics** tab over the last 30 days, charting requests, audio hours and TTS characters. Deepgram can return several rows per interval — one per grouping key — so the plugin sums them per bucket rather than assuming one row per point.

## Tips & limits

- **Synthesis is capped at 2,000 characters** per request. That is Deepgram's own limit on `/v1/speak`, and the counter enforces it before the call goes out.
- **The Speech tab caps clips at 25 MB**, well below what Deepgram itself accepts (2 GB). The panel sends audio base64-encoded inside a JSON request, and base64 inflates by a third — 25 MB is what survives that round trip. Send anything larger through Deepgram's own API directly.
- **A new key's secret exists in exactly one place: the create response.** The plugin shows it once with a warning. Deepgram only stores the key id and a truncated prefix, so there is genuinely no way to read it back.
- **Deleting a member revokes every API key they own inside that project**, not just their access.
- **Renaming is the only project edit.** `name` is the sole documented mutable attribute.
- **Balances are read-only by design.** There is no billing mutation in the API — top-ups go through Deepgram's console.
