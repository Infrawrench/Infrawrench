import type { CredentialFieldRegion, SpeechPanelOption } from "@infrawrench/plugin-base";

/**
 * Rev AI deployments, verified 2026-07-28 against
 * https://docs.rev.ai/api/global-deployments/
 *
 * Jobs are scoped to the deployment they were submitted to, so the account
 * carries the region and every call uses the matching host.
 */
export const REVAI_REGIONS: ReadonlyArray<{
  id: string;
  label: string;
  location: string;
  flag: string;
  baseUrl: string;
}> = [
  {
    id: "us",
    label: "us",
    location: "United States (default)",
    flag: "\u{1F1FA}\u{1F1F8}",
    baseUrl: "https://api.rev.ai/speechtotext/v1",
  },
  {
    id: "eu",
    label: "eu",
    location: "Frankfurt, Germany",
    flag: "\u{1F1E9}\u{1F1EA}",
    baseUrl: "https://ec1.api.rev.ai/speechtotext/v1",
  },
];

export const REVAI_REGION_FIELDS: CredentialFieldRegion[] = REVAI_REGIONS.map((region) => ({
  id: region.id,
  label: region.label,
  location: region.location,
  flag: region.flag,
}));

export function baseUrlForRegion(region: string): string {
  const match = REVAI_REGIONS.find((candidate) => candidate.id === region);
  return match ? match.baseUrl : REVAI_REGIONS[0]!.baseUrl;
}

/**
 * `transcriber` enum, verified 2026-07-28 against
 * https://docs.rev.ai/api/asynchronous/reference/jobs/submittranscriptionjob.md
 *
 * These four are the whole set. "Reverb", "Reverb Turbo" and "Whisper" are
 * marketing names for the engines behind them, NOT valid API values — sending
 * one is a rejected job, so they are deliberately absent from this picker.
 */
export const REVAI_TRANSCRIBER_OPTIONS: SpeechPanelOption[] = [
  {
    id: "machine",
    label: "Machine",
    description: "Default automatic transcription",
  },
  {
    id: "low_cost",
    label: "Low cost",
    description: "Cheaper automatic tier, lower accuracy",
  },
  {
    id: "fusion",
    label: "Fusion",
    description: "Higher-accuracy automatic tier, better on rare words",
  },
  {
    id: "human",
    label: "Human",
    description: "Human transcription — hours of turnaround, US deployment only",
  },
];

export const REVAI_DEFAULT_TRANSCRIBER = "machine";

/** Sentinel for "let Rev AI use its default (`en`)" rather than pinning a tag. */
export const REVAI_DEFAULT_LANGUAGE = "en";

/**
 * `language` enum, verified 2026-07-28 against the same reference page. Note
 * `cmn` (Mandarin), the hyphenated `en-gb` / `en-us`, and the `en/es`
 * code-switching pseudo-tag — all real values, none of them guessable.
 */
const REVAI_LANGUAGE_CODES: ReadonlyArray<[string, string]> = [
  ["en", "English"],
  ["en-us", "English (United States)"],
  ["en-gb", "English (United Kingdom)"],
  ["en/es", "English / Spanish (code-switching)"],
  ["af", "Afrikaans"],
  ["ar", "Arabic"],
  ["az", "Azerbaijani"],
  ["be", "Belarusian"],
  ["bg", "Bulgarian"],
  ["bs", "Bosnian"],
  ["ca", "Catalan"],
  ["cmn", "Mandarin Chinese"],
  ["cs", "Czech"],
  ["cy", "Welsh"],
  ["da", "Danish"],
  ["de", "German"],
  ["el", "Greek"],
  ["es", "Spanish"],
  ["et", "Estonian"],
  ["fa", "Persian"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["gl", "Galician"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["hr", "Croatian"],
  ["hu", "Hungarian"],
  ["hy", "Armenian"],
  ["id", "Indonesian"],
  ["is", "Icelandic"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["kk", "Kazakh"],
  ["kn", "Kannada"],
  ["ko", "Korean"],
  ["lt", "Lithuanian"],
  ["lv", "Latvian"],
  ["mk", "Macedonian"],
  ["mr", "Marathi"],
  ["ms", "Malay"],
  ["ne", "Nepali"],
  ["nl", "Dutch"],
  ["no", "Norwegian"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["sk", "Slovak"],
  ["sl", "Slovenian"],
  ["sr", "Serbian"],
  ["sv", "Swedish"],
  ["sw", "Swahili"],
  ["ta", "Tamil"],
  ["te", "Telugu"],
  ["th", "Thai"],
  ["tl", "Tagalog"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["ur", "Urdu"],
  ["vi", "Vietnamese"],
];

export const REVAI_LANGUAGE_OPTIONS: SpeechPanelOption[] = REVAI_LANGUAGE_CODES.map(
  ([code, name]) => ({ id: code, label: name, description: code }),
);
