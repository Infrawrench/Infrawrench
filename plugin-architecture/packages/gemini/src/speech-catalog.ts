import type { SpeechPanelOption } from "@infrawrench/plugin-base";

/**
 * The thirty prebuilt Gemini TTS voices with the one-word style descriptors
 * Google publishes for each.
 *
 * Verified: https://ai.google.dev/gemini-api/docs/speech-generation
 */
export const GEMINI_VOICES: SpeechPanelOption[] = [
  { id: "Zephyr", label: "Zephyr", description: "Bright" },
  { id: "Puck", label: "Puck", description: "Upbeat" },
  { id: "Charon", label: "Charon", description: "Informative" },
  { id: "Kore", label: "Kore", description: "Firm" },
  { id: "Fenrir", label: "Fenrir", description: "Excitable" },
  { id: "Leda", label: "Leda", description: "Youthful" },
  { id: "Orus", label: "Orus", description: "Firm" },
  { id: "Aoede", label: "Aoede", description: "Breezy" },
  { id: "Callirrhoe", label: "Callirrhoe", description: "Easy-going" },
  { id: "Autonoe", label: "Autonoe", description: "Bright" },
  { id: "Enceladus", label: "Enceladus", description: "Breathy" },
  { id: "Iapetus", label: "Iapetus", description: "Clear" },
  { id: "Umbriel", label: "Umbriel", description: "Easy-going" },
  { id: "Algieba", label: "Algieba", description: "Smooth" },
  { id: "Despina", label: "Despina", description: "Smooth" },
  { id: "Erinome", label: "Erinome", description: "Clear" },
  { id: "Algenib", label: "Algenib", description: "Gravelly" },
  { id: "Rasalgethi", label: "Rasalgethi", description: "Informative" },
  { id: "Laomedeia", label: "Laomedeia", description: "Upbeat" },
  { id: "Achernar", label: "Achernar", description: "Soft" },
  { id: "Alnilam", label: "Alnilam", description: "Firm" },
  { id: "Schedar", label: "Schedar", description: "Even" },
  { id: "Gacrux", label: "Gacrux", description: "Mature" },
  { id: "Pulcherrima", label: "Pulcherrima", description: "Forward" },
  { id: "Achird", label: "Achird", description: "Friendly" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi", description: "Casual" },
  { id: "Vindemiatrix", label: "Vindemiatrix", description: "Gentle" },
  { id: "Sadachbia", label: "Sadachbia", description: "Lively" },
  { id: "Sadaltager", label: "Sadaltager", description: "Knowledgeable" },
  { id: "Sulafat", label: "Sulafat", description: "Warm" },
];

export const DEFAULT_VOICE = "Kore";

/**
 * The TTS models addressable through the Interactions API.
 * Verified: https://ai.google.dev/gemini-api/docs/interactions/speech-generation
 */
export const TTS_MODELS: SpeechPanelOption[] = [
  {
    id: "gemini-3.1-flash-tts-preview",
    label: "gemini-3.1-flash-tts-preview",
    description: "Latest Flash TTS preview",
  },
  {
    id: "gemini-2.5-flash-preview-tts",
    label: "gemini-2.5-flash-preview-tts",
    description: "Flash TTS — faster and cheaper",
  },
  {
    id: "gemini-2.5-pro-preview-tts",
    label: "gemini-2.5-pro-preview-tts",
    description: "Pro TTS — highest quality",
  },
];

export const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";

/**
 * Languages Gemini supports, as BCP-47 tags.
 *
 * These drive the Speech panel's language picker, which is a **transcription**
 * control: `TranscribeAudioPayload` carries `language`, `SynthesizeSpeechPayload`
 * does not, so a selection here reaches `transcribeAudio` and nothing else.
 * Gemini has no language parameter on `generateContent` either, so the value is
 * honoured by naming it in the transcription instruction — see
 * `transcriptionPrompt` in client.ts. Synthesis infers the language from the
 * input text, which is the usual case anyway.
 *
 * Verified: https://ai.google.dev/gemini-api/docs/speech-generation
 */
export const TTS_LANGUAGES: SpeechPanelOption[] = [
  { id: "", label: "Match the input text" },
  { id: "ar-EG", label: "Arabic (Egyptian)" },
  { id: "bn-BD", label: "Bengali" },
  { id: "nl-NL", label: "Dutch" },
  { id: "en-US", label: "English (US)" },
  { id: "en-IN", label: "English (India)" },
  { id: "fr-FR", label: "French" },
  { id: "de-DE", label: "German" },
  { id: "hi-IN", label: "Hindi" },
  { id: "id-ID", label: "Indonesian" },
  { id: "it-IT", label: "Italian" },
  { id: "ja-JP", label: "Japanese" },
  { id: "ko-KR", label: "Korean" },
  { id: "pl-PL", label: "Polish" },
  { id: "pt-BR", label: "Portuguese (Brazil)" },
  { id: "ru-RU", label: "Russian" },
  { id: "es-US", label: "Spanish (US)" },
  { id: "ta-IN", label: "Tamil" },
  { id: "te-IN", label: "Telugu" },
  { id: "th-TH", label: "Thai" },
  { id: "tr-TR", label: "Turkish" },
  { id: "vi-VN", label: "Vietnamese" },
  { id: "uk-UA", label: "Ukrainian" },
  { id: "mr-IN", label: "Marathi" },
  { id: "ro-RO", label: "Romanian" },
];

/**
 * The audio MIME types ai.google.dev documents for `inline_data` on
 * `generateContent`.
 *
 * ⚠️ **`audio/webm` and `audio/mp4` are not on this list** — which is exactly
 * what a browser `MediaRecorder` produces (WebM/Opus on Chrome, Edge and
 * Firefox; MP4 on Safari). Firebase AI Logic, a thin wrapper over this same
 * endpoint, does list both, and Google's own Files API examples use
 * `audio/mpeg` which is also absent here — so the published list is
 * illustrative rather than a hard whitelist, and webm/mp4 probably work.
 *
 * "Probably" is not good enough to steer a file picker with, so the picker is
 * scoped to the six documented types and the panel's help text tells the user
 * which formats are safe. `transcribeAudio` still *forwards* whatever MIME
 * type it is handed rather than blocking on this list, so a browser recording
 * gets a real attempt and a real error rather than a client-side refusal.
 */
export const DOCUMENTED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
];

/** Values for the file picker's `accept` attribute. */
export const ACCEPTED_AUDIO_TYPES = [
  ...DOCUMENTED_AUDIO_MIME_TYPES,
  ".wav",
  ".mp3",
  ".aiff",
  ".aac",
  ".ogg",
  ".flac",
];

/**
 * Inline request bodies are capped at 20 MB total, so the audio itself has to
 * come in comfortably under that once base64 inflates it by a third. 14 MB of
 * raw audio encodes to roughly 18.7 MB, leaving room for the JSON envelope.
 */
export const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

/** Gemini bills 32 tokens per second of audio. */
export const AUDIO_TOKENS_PER_SECOND = 32;
