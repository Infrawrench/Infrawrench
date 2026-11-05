"use client";

// First: gt-react reads the locale cookie as soon as I18nProvider's module runs.
import "@/lib/embed-cookies";
import { I18nProvider } from "../I18nProvider";

export function EmbedI18nProvider(props: React.ComponentProps<typeof I18nProvider>) {
  return <I18nProvider {...props} />;
}
