import type { Metadata } from "next";
import { EmbedI18nProvider } from "@/components/embed/EmbedI18nProvider";
import loadTranslations from "@/lib/i18n/load-translations";
import { DEFAULT_LOCALE, isLocale, localeDir } from "@/lib/i18n/locales";
import "../../globals.css";

type Params = Promise<{ locale: string }>;

export const metadata: Metadata = {
  metadataBase: new URL("https://instances.infrawrench.com"),
  title: "Infrawrench Instances",
  icons: { icon: "/icon.png" },
  // The player for a page that is itself indexed.
  robots: { index: false, follow: false },
};

/**
 * The X Player Card embeds' root layout: the site's language and styles, and
 * none of its nav, footer or consent prompt (see `lib/embed.ts`).
 */
export default async function EmbedLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Params }>) {
  const { locale: requested } = await params;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const translations = { [locale]: await loadTranslations(locale) };
  return (
    <html lang={locale} dir={localeDir(locale)}>
      <body className="overflow-hidden">
        <EmbedI18nProvider locale={locale} translations={translations}>
          {children}
        </EmbedI18nProvider>
      </body>
    </html>
  );
}
