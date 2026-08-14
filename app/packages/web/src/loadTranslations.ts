export default async function loadTranslations(locale: string) {
  try {
    const translations = await import(`./_gt/${locale}.json`);
    return translations.default;
  } catch {
    // No file for this locale (yet) — the UI falls back to English source text.
    return {};
  }
}
