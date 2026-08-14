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

Scope it with read access to **Voices**, **Models**, **History** and **User** (the last one drives the quota gauge and reports your billing currency), plus **Text to Speech** and **Speech to Text** if you want the Speech tab, and **Workspace / usage** read if you want cost graphs. Workspace keys and personal keys both work.

![ElevenLabs Add-account form with the API key field and its scope guidance](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/add-account.png)

## The Speech tab

Open a voice for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** posts to the text-to-speech endpoint and returns mp3. The voice picker carries your whole workspace roster, and opening a voice preselects it. The character cap tracks the **selected model's own** `maximum_text_length_per_request` rather than a hardcoded number — `eleven_multilingual_v2` allows 10,000, others differ — so the counter under the box is the real limit for what you picked.
- **Transcribe** runs ElevenLabs **Scribe**: `scribe_v2` (current) or `scribe_v1` (deprecated, and labelled as such).

One shared model picker drives both halves. Leave a Scribe model selected and press Synthesize and the plugin falls back to the TTS default rather than sending a transcription model to the synthesis endpoint.

![ElevenLabs Speech tab on a voice, showing the character quota in the subtitle and a synthesized clip in the player](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/speech-tab-voice.png)

## Cost graphs

ElevenLabs accounts feed [cost graphs & budgets](../features/cloud-costs.md) with real money — not an estimate off the credit meter. Spend is collected daily from the workspace analytics API in daily buckets, broken down by **product type** (which becomes the service dimension — text to speech, speech to text, and so on) and by **region**. A year of history is available, and the trailing three days are re-fetched on each sync because usage-based charges settle a day or two late.

The credits behind each charge ride along on the row, so a service's cost and the consumption that produced it sit side by side.

![Cost graph for an ElevenLabs account broken down by product type, with text to speech as the largest series](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/cost-graph.png)

- **Your billing currency is read, never assumed.** ElevenLabs bills workspaces in USD, EUR, INR or PLN, and the plugin takes the currency from the usage response itself, falling back to the one on `GET /v1/user/subscription`. USD is only ever used when the account refuses to state a currency at all.
- **The endpoint this uses is the replacement for a deprecated one.** ElevenLabs has deprecated the old character-stats usage endpoint in favour of the workspace analytics query, so the plugin asks the new one first and only drops back to the old one if the new one is unavailable to your key.
- **On that fallback path there is no region breakdown.** The deprecated endpoint can only break usage down one way at a time, and the service and region views are each a complete decomposition of the same total — adding them together would report every charge twice. Service is kept and region is left empty, so the totals stay honest.
- **A narrowly scoped personal key still works,** but reports only its own usage rather than the whole workspace's. Use a workspace key, or grant the key workspace usage access, for account-wide numbers.

## Tips & limits

- **This spends real quota.** Synthesis bills against your character allowance and transcription bills per minute of audio — the tab's subtitle shows characters used against your limit for the current period so you can watch it move.
- **Transcription uploads are capped at 25 MB** here. The API itself accepts up to 5 GB, but the Speech tab base64-encodes the clip through an ordinary JSON request, so the limit is set low enough that oversized files are rejected before they are encoded rather than after.
- **ElevenLabs returns synthesis audio as `application/octet-stream`** even though the bytes are mp3. The plugin relabels it so the browser's player will accept it.
- **Preset and premade voices belong to ElevenLabs.** Deleting works on voices your workspace owns.
- **Pronunciation dictionaries are read-only here.** The API exposes listing and version metadata; creating and editing rules happens in the ElevenLabs dashboard, and the dictionary id plus latest version id are surfaced as outputs so you can reference them in your own calls.
- **History is where the character accounting lives.** Each item records exactly what it was billed, which is usually a faster answer than reconciling against the quota gauge.
