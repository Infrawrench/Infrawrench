import { initializeGTSPA } from "gt-react";
import { getStoredLocale } from "@infrawrench/ui";
import gtConfig from "../gt.config.json";
import loadTranslations from "./loadTranslations";

// gt-react must resolve the locale and load its translations before anything
// renders, so the app module is imported only once this settles. The stored
// locale (the Settings → General language picker) is the first candidate;
// without one gt-react falls back to its cookie, then the browser language.
const storedLocale = getStoredLocale();
const projectId = import.meta.env.VITE_GT_PROJECT_ID;
const devApiKey = import.meta.env.VITE_GT_DEV_API_KEY;

// An async IIFE rather than top-level await: the build's browser targets
// (vite's defaults) predate TLA support.
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
