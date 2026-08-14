import { initializeGT, initializeGTSPA } from "gt-react";

/**
 * Initialize gt-react for tests, English-only and offline — these assert
 * source strings, never translations.
 *
 * Two shapes, because this suite mixes environments. Files that render
 * components opt into jsdom (`@vitest-environment jsdom`) and need the SPA
 * setup, which builds the condition store the hooks read; without it `useGT()`
 * throws "GTContext was accessed outside of a <GTProvider>". The default
 * node-environment files only need the config singleton, which module-scope
 * `msg()` (e.g. the settings registry) reads at import time.
 */
if (typeof document === "undefined") {
  initializeGT({ defaultLocale: "en", locales: ["en"] });
} else {
  await initializeGTSPA({
    defaultLocale: "en",
    locales: ["en"],
    loadTranslations: async () => ({}),
  });
}
