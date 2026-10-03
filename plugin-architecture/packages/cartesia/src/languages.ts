import type { SpeechPanelOption } from "@infrawrench/plugin-base";

/**
 * A trimmed language list shared by the Speech tab's transcription half and
 * the agent language picker. Ink Whisper accepts 99+ ISO-639-1 codes; these
 * are the ones the Sonic voice library actually covers (Urdu arrived with
 * Sonic 3.6), so the two halves of the panel agree.
 * https://docs.cartesia.ai/build-with-cartesia/models/tts
 */
export const LANGUAGES: SpeechPanelOption[] = [
  { id: "en", label: "English" },
  { id: "ar", label: "Arabic" },
  { id: "bn", label: "Bengali" },
  { id: "bg", label: "Bulgarian" },
  { id: "zh", label: "Chinese" },
  { id: "hr", label: "Croatian" },
  { id: "cs", label: "Czech" },
  { id: "da", label: "Danish" },
  { id: "nl", label: "Dutch" },
  { id: "fi", label: "Finnish" },
  { id: "fr", label: "French" },
  { id: "ka", label: "Georgian" },
  { id: "de", label: "German" },
  { id: "el", label: "Greek" },
  { id: "gu", label: "Gujarati" },
  { id: "he", label: "Hebrew" },
  { id: "hi", label: "Hindi" },
  { id: "hu", label: "Hungarian" },
  { id: "id", label: "Indonesian" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese" },
  { id: "kn", label: "Kannada" },
  { id: "ko", label: "Korean" },
  { id: "ms", label: "Malay" },
  { id: "ml", label: "Malayalam" },
  { id: "mr", label: "Marathi" },
  { id: "no", label: "Norwegian" },
  { id: "pl", label: "Polish" },
  { id: "pt", label: "Portuguese" },
  { id: "pa", label: "Punjabi" },
  { id: "ro", label: "Romanian" },
  { id: "ru", label: "Russian" },
  { id: "sk", label: "Slovak" },
  { id: "es", label: "Spanish" },
  { id: "sv", label: "Swedish" },
  { id: "tl", label: "Tagalog" },
  { id: "ta", label: "Tamil" },
  { id: "te", label: "Telugu" },
  { id: "th", label: "Thai" },
  { id: "tr", label: "Turkish" },
  { id: "uk", label: "Ukrainian" },
  { id: "ur", label: "Urdu" },
  { id: "vi", label: "Vietnamese" },
];

/** Bare codes, for enum fields on resource types. */
export const LANGUAGE_CODES: string[] = LANGUAGES.map((language) => language.id);
