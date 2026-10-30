import { createLookupOptions, hashMessage, interpolateMessage } from "gt-i18n/internal";
import loadTranslations from "./load-translations";
import { DEFAULT_LOCALE } from "./locales";

export type Translate = (source: string, vars?: Record<string, string | number>) => string;

/**
 * Translation outside a React tree: page metadata and the OG image, which
 * render on the server with no `GTProvider` above them. Sources are declared
 * with `msg("…")` at the call site, which returns the string unchanged and is
 * what the gt CLI extracts; this performs the same lookup gt-react does at
 * render time (content hash of the ICU source, then ICU interpolation), so one
 * catalog entry serves both. A missing entry renders the English source.
 */
export async function getTranslator(locale: string): Promise<Translate> {
  return translatorFor(locale, await loadTranslations(locale));
}

export function translatorFor(locale: string, catalog: Record<string, string>): Translate {
  return (source, vars = {}) => {
    const options = createLookupOptions(locale, vars, "ICU");
    const target = locale === DEFAULT_LOCALE ? undefined : catalog[hashMessage(source, options)];
    return interpolateMessage({
      source,
      ...(target !== undefined ? { target } : {}),
      options,
      sourceLocale: DEFAULT_LOCALE,
    });
  };
}
