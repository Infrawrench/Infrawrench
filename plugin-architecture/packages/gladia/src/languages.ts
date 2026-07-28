import type { SpeechPanelOption } from "@infrawrench/plugin-base";

/**
 * Gladia's supported transcription languages, verified 2026-07-28 against
 * https://docs.gladia.io/chapters/language/supported-languages
 *
 * Codes are ISO 639-1 two-letter tags, falling back to ISO 639-3 where no
 * two-letter code exists (`haw` for Hawaiian). These are the values that go
 * into `language_config.languages[]`.
 */
export const GLADIA_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "af", name: "Afrikaans" },
  { code: "sq", name: "Albanian" },
  { code: "am", name: "Amharic" },
  { code: "ar", name: "Arabic" },
  { code: "hy", name: "Armenian" },
  { code: "as", name: "Assamese" },
  { code: "az", name: "Azerbaijani" },
  { code: "ba", name: "Bashkir" },
  { code: "eu", name: "Basque" },
  { code: "be", name: "Belarusian" },
  { code: "bn", name: "Bengali" },
  { code: "bs", name: "Bosnian" },
  { code: "br", name: "Breton" },
  { code: "bg", name: "Bulgarian" },
  { code: "ca", name: "Catalan" },
  { code: "zh", name: "Chinese" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "et", name: "Estonian" },
  { code: "fo", name: "Faroese" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "gl", name: "Galician" },
  { code: "ka", name: "Georgian" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "gu", name: "Gujarati" },
  { code: "ht", name: "Haitian Creole" },
  { code: "ha", name: "Hausa" },
  { code: "haw", name: "Hawaiian" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "is", name: "Icelandic" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "jw", name: "Javanese" },
  { code: "kn", name: "Kannada" },
  { code: "kk", name: "Kazakh" },
  { code: "km", name: "Khmer" },
  { code: "ko", name: "Korean" },
  { code: "lo", name: "Lao" },
  { code: "la", name: "Latin" },
  { code: "lv", name: "Latvian" },
  { code: "ln", name: "Lingala" },
  { code: "lt", name: "Lithuanian" },
  { code: "lb", name: "Luxembourgish" },
  { code: "mk", name: "Macedonian" },
  { code: "mg", name: "Malagasy" },
  { code: "ms", name: "Malay" },
  { code: "ml", name: "Malayalam" },
  { code: "mt", name: "Maltese" },
  { code: "mi", name: "Maori" },
  { code: "mr", name: "Marathi" },
  { code: "mn", name: "Mongolian" },
  { code: "my", name: "Myanmar" },
  { code: "ne", name: "Nepali" },
  { code: "no", name: "Norwegian" },
  { code: "nn", name: "Nynorsk" },
  { code: "oc", name: "Occitan" },
  { code: "ps", name: "Pashto" },
  { code: "fa", name: "Persian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "pa", name: "Punjabi" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sa", name: "Sanskrit" },
  { code: "sr", name: "Serbian" },
  { code: "sn", name: "Shona" },
  { code: "sd", name: "Sindhi" },
  { code: "si", name: "Sinhala" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "so", name: "Somali" },
  { code: "es", name: "Spanish" },
  { code: "su", name: "Sundanese" },
  { code: "sw", name: "Swahili" },
  { code: "sv", name: "Swedish" },
  { code: "tl", name: "Tagalog" },
  { code: "tg", name: "Tajik" },
  { code: "ta", name: "Tamil" },
  { code: "tt", name: "Tatar" },
  { code: "te", name: "Telugu" },
  { code: "th", name: "Thai" },
  { code: "bo", name: "Tibetan" },
  { code: "tr", name: "Turkish" },
  { code: "tk", name: "Turkmen" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "uz", name: "Uzbek" },
  { code: "vi", name: "Vietnamese" },
  { code: "cy", name: "Welsh" },
  { code: "wo", name: "Wolof" },
  { code: "yi", name: "Yiddish" },
  { code: "yo", name: "Yoruba" },
];

/**
 * Sentinel for "let Gladia detect it". Sending this means we omit
 * `language_config` entirely, which is the documented auto-detect behaviour.
 * The docs explicitly warn against turning `code_switching` on with an empty
 * `languages` list, so we never do that.
 */
export const GLADIA_AUTO_LANGUAGE = "auto";

export const GLADIA_LANGUAGE_OPTIONS: SpeechPanelOption[] = [
  {
    id: GLADIA_AUTO_LANGUAGE,
    label: "Auto-detect",
    description: "Let Gladia pick the language from the audio",
  },
  ...GLADIA_LANGUAGES.map((language) => ({
    id: language.code,
    label: language.name,
    description: language.code,
  })),
];

/**
 * Transcription models, verified 2026-07-28 against the request schema of
 * https://docs.gladia.io/api-reference/v2/pre-recorded/init — the served
 * OpenAPI document has historically omitted `model` even though the endpoint
 * accepts it, so this list tracks the API reference rather than the spec file.
 */
export const GLADIA_MODEL_OPTIONS: SpeechPanelOption[] = [
  {
    id: "solaria-1",
    label: "Solaria-1",
    description: "Gladia's default model — 100+ languages",
  },
  {
    id: "solaria-3",
    label: "Solaria-3",
    description: "Latest generation, pre-recorded (async) only",
  },
];

export const GLADIA_DEFAULT_MODEL = "solaria-1";
