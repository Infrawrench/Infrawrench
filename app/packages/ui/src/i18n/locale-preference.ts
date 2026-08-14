/**
 * The user's chosen UI language, shared by the web and desktop entrypoints.
 *
 * localStorage rather than gt-react's own locale cookie because the desktop
 * renderer runs on a file:// origin, where Chromium silently drops cookie
 * writes. Both entrypoints pass the stored value to initializeGTSPA() as the
 * first locale candidate on boot, and the settings LanguageCard writes it
 * before handing the change to gt-react.
 */
const LOCALE_STORAGE_KEY = "infrawrench-locale";

export function getStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: string): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage denied (private mode) — on web the cookie gt-react writes
    // still persists the choice; on desktop it lasts for the session.
  }
}
