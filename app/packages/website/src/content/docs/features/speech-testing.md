---
title: Speech testing
description: Synthesize speech and transcribe audio against your connected AI providers, without leaving the app.
sidebar_order: 6
---

Hear a voice, test a transcription and check your key works, all with your own speech provider account and credentials. That's what the **Speech** tab is for.

![The Speech tab on an ElevenLabs voice, showing the text box, voice picker and an audio player with a synthesized clip](https://agent-assets.infrawrench.com/docs-screenshots/features/speech-testing/tts-elevenlabs-voice.png)

## Where to find it

Open any resource from a provider that does speech and pick the **Speech** tab. What you see depends on what the provider supports:

- **Text to speech:** a text box, a voice picker and a model picker. The clip plays inline with a download link.
- **Speech to text:** record from your microphone or upload a clip, then read the transcript.

If the provider does both, you get both sections on one tab.

## Turn text into speech

1. Pick a voice and a model. The lists come from your account, so you never have to look up an id.
2. Type your text.
3. Press **Synthesize**.

The character counter shows the provider's real per-request limit. If you go over, the request isn't sent, so you don't waste quota on a call that would be rejected.

Each clip comes with a short summary (characters billed, model used) and a **Download** link.

## Transcribe audio

Get audio in one of two ways:

- **Record** from your microphone. Press Record, speak, press Stop. Your browser asks for microphone permission the first time.
- **Upload a clip** from disk.

Play it back if you want, then press **Transcribe**.

Some models only take certain languages. When you pick one of those, the language picker lists just the languages it takes, and a language it doesn't take switches to one it does. Gladia's Solaria-3 is an example: it needs one of five named languages and can't auto-detect.

The transcript shows up below, with the detected language, clip length and confidence when the provider reports them. If the provider returns word timings, **Show word timings** opens a table of every word with its start, end and speaker label.

![The speech-to-text half after a recording, showing the transcript and the expanded word-timings table with speaker labels](https://agent-assets.infrawrench.com/docs-screenshots/features/speech-testing/stt-word-timings.png)

## On your phone

The [mobile app](./mobile-app.md) has the same features on their own screen. Tap **Speech** on the resource page.

- Voice, model and language pickers open as sheets. The language list follows the model, as on desktop and web.
- The character counter has the same limit.
- Clips play inline. **Save** opens the share sheet instead of downloading.
- Speech to text records from the phone's microphone (iOS and Android ask for permission the first time) or takes a clip from the file picker.

Everything else, including the word-timings table, works the same as on web.

<insert [The mobile Speech screen with the voice picker sheet open over the text box, and below it a synthesized clip with its play button and Save control] here>

## Things to know

- **It uses real quota.** Every synthesis and transcription is a billed call on your own account. There's no sandbox mode.
- **Recording needs HTTPS.** Browsers only allow microphone access over HTTPS (or on `localhost`). If there's no Record button, your browser doesn't support recording or the provider can't accept browser recordings (Cohere is one, and says so next to the upload button). Upload a clip instead. On mobile, if you denied microphone access, turn it back on in your phone's settings for the app. Picking a clip works either way.
- **Clips are capped at 25 MB.** This is an Infrawrench limit, not the provider's. For long recordings, use the provider's own API.
- **Some providers take longer.** Services that queue transcription jobs (AssemblyAI, Speechmatics, Rev.ai) can show "Transcribing…" for a while on a long clip.
- **On desktop, this only works for accounts you added locally.** Cloud-synced accounts aren't supported for speech yet, and the panel tells you so.

## Related

- [AI chat](./ai-chat.md): the assistant built into the app, separate from these provider accounts.
- [Send a test message](./send-test-message.md): the same idea for pub/sub resources.
