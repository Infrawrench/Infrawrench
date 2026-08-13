import type { SpeechPanelOption } from "@infrawrench/plugin-base";

/**
 * Speech-tab catalogues.
 *
 * OpenAI has no "list voices" endpoint — the built-in voice set is part of the
 * request schema, so it has to be a literal here. The list below is exactly
 * `VoiceIdsShared` from the published OpenAPI description (openapi.yaml v2.3.0,
 * verified 2026-07-29); `fable`, `onyx` and `nova` still resolve for backwards
 * compatibility but are no longer in the enum, so they are not offered.
 */
export const TTS_VOICES: SpeechPanelOption[] = [
  { id: "alloy", label: "Alloy", description: "Neutral, even-toned — the API default" },
  { id: "ash", label: "Ash", description: "Warm and conversational" },
  { id: "ballad", label: "Ballad", description: "Soft, expressive, slower cadence" },
  { id: "coral", label: "Coral", description: "Bright and upbeat" },
  { id: "echo", label: "Echo", description: "Calm and measured" },
  { id: "sage", label: "Sage", description: "Steady and reassuring" },
  { id: "shimmer", label: "Shimmer", description: "Light and airy" },
  { id: "verse", label: "Verse", description: "Narrative, story-telling delivery" },
  { id: "marin", label: "Marin", description: "Natural conversational voice" },
  { id: "cedar", label: "Cedar", description: "Deeper, grounded conversational voice" },
];

export const DEFAULT_VOICE = "alloy";

/**
 * Snapshot-pinned so a silent model refresh can't change how the same text
 * sounds between two runs. `gpt-4o-mini-tts` (the floating alias) also works.
 */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";
export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";

/** Models `POST /v1/audio/speech` accepts, per `CreateSpeechRequest.model`. */
const TTS_MODELS = new Set(["gpt-4o-mini-tts-2025-12-15", "gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);

/** Models `POST /v1/audio/transcriptions` accepts, per `CreateTranscriptionRequest.model`. */
const STT_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-transcribe",
  "whisper-1",
  "gpt-4o-transcribe-diarize",
]);

/**
 * `instructions` and `stream_format` are documented as unsupported on the two
 * legacy `tts-1*` models. Sending either produces a 400 rather than being
 * ignored, so the client has to branch on the chosen model.
 */
export const LEGACY_TTS_MODELS = new Set(["tts-1", "tts-1-hd"]);

/** The one transcription model that returns speaker-annotated segments. */
export const DIARIZE_MODEL = "gpt-4o-transcribe-diarize";

/**
 * Timestamps require `verbose_json`, and `verbose_json` is only accepted by
 * `whisper-1` — the gpt-4o transcribe family is `json`-only (plus `text`,
 * `srt`, `vtt`). Asking any of them for `verbose_json` is a 400, so the word
 * table only ever appears for whisper-1 and for the diarize model's segments.
 */
export const VERBOSE_JSON_MODEL = "whisper-1";

/**
 * One shared dropdown drives both halves of the Speech panel, so it has to
 * carry synthesis and transcription models together. The client re-selects a
 * sensible default when the user leaves an STT model selected and clicks
 * Synthesize (or the other way round).
 */
export const SPEECH_MODELS: SpeechPanelOption[] = [
  {
    id: DEFAULT_TTS_MODEL,
    label: "gpt-4o-mini-tts (2025-12-15)",
    description: "Text-to-speech · steerable with the tone instructions box",
  },
  { id: "tts-1", label: "tts-1", description: "Text-to-speech · lowest latency, no steering" },
  { id: "tts-1-hd", label: "tts-1-hd", description: "Text-to-speech · higher fidelity" },
  {
    id: "gpt-4o-transcribe",
    label: "gpt-4o-transcribe",
    description: "Transcription · highest accuracy",
  },
  {
    id: "gpt-4o-mini-transcribe",
    label: "gpt-4o-mini-transcribe",
    description: "Transcription · cheaper and faster",
  },
  {
    id: "gpt-transcribe",
    label: "gpt-transcribe",
    description: "Transcription · supports keyword biasing and multi-language hints",
  },
  {
    id: "whisper-1",
    label: "whisper-1",
    description: "Transcription · the only model that returns word timestamps",
  },
  {
    id: DIARIZE_MODEL,
    label: "gpt-4o-transcribe-diarize",
    description: "Transcription · labels each segment with a speaker",
  },
];

/**
 * `language` is an ISO-639-1 hint that improves accuracy and latency. It is
 * optional, so the list leads with an explicit auto-detect entry that the
 * client simply omits from the request.
 */
export const AUTO_LANGUAGE = "auto";

export const STT_LANGUAGES: SpeechPanelOption[] = [
  { id: AUTO_LANGUAGE, label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "pl", label: "Polish" },
  { id: "ru", label: "Russian" },
  { id: "uk", label: "Ukrainian" },
  { id: "tr", label: "Turkish" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
];

/** `CreateSpeechRequest.input` is capped at 4096 characters. */
export const MAX_TTS_CHARACTERS = 4096;

/** The documented upload ceiling for `POST /v1/audio/transcriptions`. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** File formats the transcription endpoint accepts, per `CreateTranscriptionRequest.file`. */
export const ACCEPTED_AUDIO_TYPES = [
  "audio/flac",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/mpeg",
  "video/webm",
  ".flac",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".ogg",
  ".wav",
  ".webm",
];

/** True when the model id is one the Speech tab can synthesise with. */
export function isTtsModel(modelId: string): boolean {
  return TTS_MODELS.has(modelId);
}

/** True when the model id is one the Speech tab can transcribe with. */
export function isSttModel(modelId: string): boolean {
  return STT_MODELS.has(modelId);
}

/**
 * `MediaRecorder` hands us `audio/webm;codecs=opus` on Chromium and
 * `audio/mp4` on Safari. The API keys off the filename extension as well as
 * the part's content type, so the two have to agree — this maps the browser's
 * MIME type onto an extension the endpoint recognises. The MIME type itself is
 * always forwarded verbatim; nothing is transcoded.
 */
export function audioFileName(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext =
    base === "audio/webm" || base === "video/webm"
      ? "webm"
      : base === "audio/mp4" || base === "video/mp4" || base === "audio/x-m4a"
        ? "mp4"
        : base === "audio/mpeg" || base === "audio/mp3"
          ? "mp3"
          : base === "audio/wav" || base === "audio/x-wav" || base === "audio/wave"
            ? "wav"
            : base === "audio/ogg"
              ? "ogg"
              : base === "audio/flac" || base === "audio/x-flac"
                ? "flac"
                : "webm";
  return `clip.${ext}`;
}
