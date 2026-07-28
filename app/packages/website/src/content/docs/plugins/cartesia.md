---
title: Cartesia
description: Browse Cartesia voices and pronunciation dictionaries, list API keys and credit usage with an admin key, and run Sonic synthesis and Ink Whisper transcription from the Speech tab.
sidebar_order: 46
---

## What you can manage

- **Voices** — voices your organization owns and voices from the shared library, with language, locales, gender, country, access type and whether it is a Pro clone. Delete the ones you own.
- **Pronunciation dictionaries** — named sets of text-to-pronunciation overrides applied at synthesis time, with their entries listed inline (delete).
- **API keys** — the keys issued for this organization, with who created them and whether that person is still in the org. Read-only, and admin-key only.

## Credentials

Cartesia gates two endpoints behind a **separate admin key**, so this plugin asks for both.

**API Key** (required) — Cartesia console → **API Keys**. Starts `sk_car_`. This drives voice and pronunciation-dictionary listing, text-to-speech and transcription.

**Admin API Key** (optional) — created in the same console with the **Admin** key type. Starts `sk_car_admin_` and is **not** interchangeable with the key above. Cartesia only accepts an admin key on `/usage/credits` and `/api-keys`, so leaving it blank simply hides the **API Keys** list and the credit-usage figure. Voices, dictionaries, synthesis and transcription all keep working.

<insert [Cartesia Add-account form showing the required API key and the optional admin API key with its sk_car_admin_ placeholder] here>

## The Speech tab

Open a voice for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** runs **Sonic** — `sonic-3.5` (current flagship, sub-90 ms latency), `sonic-3` (previous generation, pinned) or `sonic-latest` (a rolling beta that can change without notice, so not for production). Opening a voice preselects it. Audio comes back as 44.1 kHz 128 kbps mp3.
- **Transcribe** always runs **`ink-whisper`** — Cartesia's only transcription model — so the model picker applies to synthesis only, and the language picker applies to transcription.

<insert [Cartesia Speech tab on a voice, showing the Sonic model picker and a synthesized clip in the player] here>

## Tips & limits

- **The Speech tab sets no character cap.** Cartesia documents no per-request transcript limit, so rather than inventing one the plugin lets the provider's own error surface if you go too long.
- **Credit usage is consumption-only.** `GET /usage/credits` returns what you have spent over the last 30 days with no plan limit in the response, so it is never drawn as a used-versus-limit gauge — there is nothing honest to draw it against.
- **Preview audio is usually absent.** Cartesia only returns a voice's `preview_file_url` when the request asks for it with `expand[]=preview_file_url`, and the voice detail page says so where the field would be.
- **There is no `GET /models` endpoint.** The Sonic list is a fixed enum in the plugin rather than a live catalogue, because Cartesia does not publish one.
- **Every request carries a pinned API date.** Cartesia rejects any call without the `Cartesia-Version` header, GETs included. The plugin sends it; you never see it.
- **Shared-library voices belong to Cartesia.** They can be used but not deleted — only voices your organization owns are removable.
