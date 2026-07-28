import type { TranscribeAudioResult } from "@infrawrench/plugin-base";

/**
 * Pure helpers behind the Speech test surface (`DetailViewSchema.speechPanel`).
 *
 * The web/desktop `SpeechPanel` and the mobile Speech screen render completely
 * different trees — one is DOM, one is React Native — but they have to agree on
 * the numbers and the wording: the same size cap, the same "the limit is …"
 * sentence, the same MIME→extension map used for download filenames and for
 * naming a recorded clip. That agreement lives here rather than being copied
 * into each host.
 *
 * Nothing in this file touches Blob, FileReader, or the file system. Base64 is
 * per-host: the browser goes through `FileReader`/`atob`, and mobile hands the
 * job to `expo-file-system` (`File.base64()` / `write(…, { encoding: "base64" })`).
 */

/** Fallback cap when a plugin doesn't declare one — the smallest limit we ship against. */
export const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Fallback `accept` list for the upload path when the plugin doesn't narrow it. */
export const DEFAULT_ACCEPTED_AUDIO_TYPES = [
  "audio/*",
  ".mp3",
  ".wav",
  ".m4a",
  ".flac",
  ".ogg",
  ".webm",
  ".mp4",
];

/** Map a MIME type to a file extension for downloads and provider filenames. */
export function audioExtensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
    case "audio/opus":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
    case "audio/aac":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/flac":
      return ".flac";
    case "audio/l16":
    case "audio/pcm":
      return ".pcm";
    default:
      return ".audio";
  }
}

/**
 * The inverse map, for hosts that get an extension rather than a MIME type.
 * A native recorder names its output file (`.m4a`, `.3gp`) and says nothing
 * about the content type, but `TranscribeAudioPayload.mimeType` is what the
 * plugin forwards to the provider — so the extension has to be resolved to a
 * real type rather than guessed at the other end.
 */
export function audioMimeForExtension(extension: string): string {
  const ext = extension.trim().toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "mp3":
    case "mpeg":
      return "audio/mpeg";
    case "wav":
    case "wave":
      return "audio/wav";
    case "ogg":
    case "oga":
    case "opus":
      return "audio/ogg";
    case "webm":
      return "audio/webm";
    case "m4a":
    case "mp4":
    case "aac":
      return "audio/mp4";
    case "3gp":
    case "3gpp":
      return "audio/3gpp";
    case "amr":
      return "audio/amr";
    case "flac":
      return "audio/flac";
    case "caf":
      return "audio/x-caf";
    default:
      return "application/octet-stream";
  }
}

/** Byte count for a clip badge — KB below a megabyte, MB above it. */
export function formatAudioBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate the synthesis input before spending a provider call. Returns the
 * message to show, or `null` when the text is good to send.
 */
export function speechTextError(text: string, maxCharacters?: number): string | null {
  if (!text.trim()) return "Enter some text to synthesize.";
  if (maxCharacters != null && text.length > maxCharacters) {
    return `Text is ${text.length} characters — the limit is ${maxCharacters}.`;
  }
  return null;
}

/**
 * Refuse an oversized clip client-side, before it is base64-encoded — the
 * encode inflates it by 4/3 and the request would 413 at the ingress with
 * nothing in the logs to explain it. `label` is the clip's filename when the
 * user picked one, so the message names the offending file.
 */
export function audioSizeError(bytes: number, maxBytes: number, label = "Clip"): string | null {
  if (bytes <= maxBytes) return null;
  return `${label} is ${formatAudioBytes(bytes)} — the limit is ${formatAudioBytes(maxBytes)}.`;
}

/** One-line summary under a synthesized clip when the plugin didn't supply one. */
export function describeSynthesis(byteLength: number, characters?: number): string {
  return `${formatAudioBytes(byteLength)}${
    characters != null ? ` · ${characters} characters billed` : ""
  }`;
}

/** One-line summary under a transcript when the plugin didn't supply one. */
export function describeTranscript(result: TranscribeAudioResult): string {
  const parts: string[] = [];
  if (result.durationSeconds != null) parts.push(`${result.durationSeconds.toFixed(1)}s of audio`);
  if (result.language) parts.push(result.language);
  if (result.confidence != null) parts.push(`${Math.round(result.confidence * 100)}% confidence`);
  return parts.join(" · ");
}
