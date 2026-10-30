import { DEFAULT_LOCALE } from "./locales";

/** One locale's catalog (`_gt/<locale>.json`, content hash to translation). */
export default async function loadTranslations(locale: string): Promise<Record<string, string>> {
  if (locale === DEFAULT_LOCALE) return {};
  try {
    const translations = await import(`../../_gt/${locale}.json`);
    return translations.default;
  } catch {
    // No file for this locale (yet): the page falls back to English source text.
    return {};
  }
}
