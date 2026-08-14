import { initializeGTSPA } from "gt-react";
import { getStoredLocale } from "@infrawrench/ui";
import gtConfig from "../gt.config.json";
import loadTranslations from "./loadTranslations";
import { installCookieStoreShim } from "./lib/cookie-store-shim";

// Before anything reads a cookie: the packaged renderer runs on file://, which
// discards cookie writes, and gt-react ranks a missing locale cookie below the
// OS language — so without this the language picker silently does nothing.
installCookieStoreShim();

// gt-react must resolve the locale and load its translations before anything
// renders, so the app module is imported only once this settles. The stored
// locale (Settings → General language picker) is the first candidate — it is
// also the only one that persists here: the packaged renderer runs on a
// file:// origin, where gt-react's own locale cookie is silently dropped.
const storedLocale = getStoredLocale();
const projectId = import.meta.env.VITE_GT_PROJECT_ID;
const devApiKey = import.meta.env.VITE_GT_DEV_API_KEY;

// An async IIFE rather than top-level await: the build's browser targets
// (electron-vite's defaults) predate TLA support.
void (async () => {
  await initializeGTSPA({
    defaultLocale: gtConfig.defaultLocale,
    locales: gtConfig.locales,
    loadTranslations,
    ...(projectId ? { projectId } : {}),
    ...(devApiKey ? { devApiKey } : {}),
    ...(storedLocale ? { locale: storedLocale } : {}),
  });

  await import("./main");
})();
