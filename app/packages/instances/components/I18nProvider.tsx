"use client";

import { GTProvider, initializeGT } from "gt-react";
import gtConfig from "@/gt.config.json";
import loadTranslations from "@/lib/i18n/load-translations";

// gt-react's server-rendered mode: `initializeGT` resolves to the server
// runtime during SSR and the browser runtime once hydrated, and the provider
// is handed the locale and its catalog by the layout, so the HTML arrives
// already translated.
initializeGT({
  defaultLocale: gtConfig.defaultLocale,
  locales: gtConfig.locales,
  loadTranslations,
});

export function I18nProvider({
  locale,
  translations,
  children,
}: {
  locale: string;
  translations: Record<string, Record<string, string>>;
  children: React.ReactNode;
}) {
  return (
    <GTProvider locale={locale} translations={translations}>
      {children}
    </GTProvider>
  );
}
