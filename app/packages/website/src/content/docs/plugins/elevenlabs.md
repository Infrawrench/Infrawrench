---
title: ElevenLabs
description: Browse ElevenLabs voices, models, pronunciation dictionaries and generation history, and run text-to-speech and Scribe transcription from the Speech tab.
sidebar_order: 42
---

## What you can manage

- **Voices** — premade, cloned, professional and generated voices, with accent, gender, age, use case and a preview clip (delete).
- **Models** — the speech models this workspace can call, each with its real `maximum_text_length_per_request`, language count, and whether it supports voice conversion, style and speaker boost. Read-only.
- **Pronunciation dictionaries** — the phoneme and alias rules applied at synthesis time, with their latest version id. Read-only here; edit them in the ElevenLabs dashboard.
- **History items** — previously generated clips, with the text, the voice, the model and the exact character count you were billed (delete).

Every resource's dashboard card leads with your subscription's **character quota gauge**, read from `GET /v1/user/subscription`.

## Credentials

One field. ElevenLabs dashboard → profile menu (bottom-left avatar) → **API Keys** → **Create API Key**, or [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys). The key is sent as the `xi-api-key` header.

Scope it with read access to **Voices**, **Models**, **History** and **User** (the last one drives the quota gauge), plus **Text to Speech** and **Speech to Text** if you want the Speech tab. Workspace keys and personal keys both work.

<insert [ElevenLabs Add-account form with the API key field and its scope guidance] here>

## The Speech tab

Open a voice for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** posts to the text-to-speech endpoint and returns mp3. The voice picker carries your whole workspace roster, and opening a voice preselects it. The character cap tracks the **selected model's own** `maximum_text_length_per_request` rather than a hardcoded number — `eleven_multilingual_v2` allows 10,000, others differ — so the counter under the box is the real limit for what you picked.
- **Transcribe** runs ElevenLabs **Scribe**: `scribe_v2` (current) or `scribe_v1` (deprecated, and labelled as such).

One shared model picker drives both halves. Leave a Scribe model selected and press Synthesize and the plugin falls back to the TTS default rather than sending a transcription model to the synthesis endpoint.

<insert [ElevenLabs Speech tab on a voice, showing the character quota in the subtitle and a synthesized clip in the player] here>

## Tips & limits

- **This spends real quota.** Synthesis bills against your character allowance and transcription bills per minute of audio — the tab's subtitle shows characters used against your limit for the current period so you can watch it move.
- **Transcription uploads are capped at 25 MB** here. The API itself accepts up to 5 GB, but the Speech tab base64-encodes the clip through an ordinary JSON request, so the limit is set low enough that oversized files are rejected before they are encoded rather than after.
- **ElevenLabs returns synthesis audio as `application/octet-stream`** even though the bytes are mp3. The plugin relabels it so the browser's player will accept it.
- **Preset and premade voices belong to ElevenLabs.** Deleting works on voices your workspace owns.
- **Pronunciation dictionaries are read-only here.** The API exposes listing and version metadata; creating and editing rules happens in the ElevenLabs dashboard, and the dictionary id plus latest version id are surfaced as outputs so you can reference them in your own calls.
- **History is where the character accounting lives.** Each item records exactly what it was billed, which is usually a faster answer than reconciling against the quota gauge.
