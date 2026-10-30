import gtConfig from "../../gt.config.json";

/**
 * The site's languages: the desktop app's (`gt.config.json` there and here
 * list the same locales). English is the source and lives at the unprefixed
 * URLs (`/aws/ec2/m5.large`); every other language is a path prefix
 * (`/fr/aws/ec2/m5.large`), which `proxy.ts` maps onto the `[locale]` route.
 * A prefix rather than a cookie because pages are cached at the edge without
 * cookies, and so each language is its own crawlable, linkable page.
 */
export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const LOCALES: readonly string[] = [gtConfig.defaultLocale, ...gtConfig.locales];

/** Remembers a visitor's explicit choice, so `proxy.ts` can send English URLs to their language. */
export const LOCALE_COOKIE = "instances-locale";

export function isLocale(value: string): boolean {
  return LOCALES.includes(value);
}

/** A site path (`/aws/ec2/m5.large`) in a locale. */
export function localePath(locale: string, path: string): string {
  if (locale === DEFAULT_LOCALE) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

/** The site path without its locale prefix, and the locale it had. */
export function splitLocale(pathname: string): { locale: string; path: string } {
  const first = pathname.split("/")[1] ?? "";
  if (first !== DEFAULT_LOCALE && isLocale(first)) {
    return { locale: first, path: pathname.slice(first.length + 1) || "/" };
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}
