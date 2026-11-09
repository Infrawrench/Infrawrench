import type { Metadata } from "next";
import { msg } from "gt-react";
import { Footer } from "@/components/Footer";
import { I18nProvider } from "@/components/I18nProvider";
import { Nav } from "@/components/Nav";
import loadTranslations from "@/lib/i18n/load-translations";
import { DEFAULT_LOCALE, isLocale, localeDir } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import "../globals.css";

type Params = Promise<{ locale: string }>;

async function resolveLocale(params: Params): Promise<string> {
  const { locale } = await params;
  // An unknown prefix 404s in the page; the shell still needs a language.
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const tr = await getTranslator(await resolveLocale(params));
  return {
    metadataBase: new URL("https://instances.infrawrench.com"),
    title: "Infrawrench Instances",
    description: tr(
      msg(
        "Instance specs and prices for AWS, Azure, Google Cloud, Alibaba Cloud, Oracle Cloud, IBM Cloud, Hetzner, OVHcloud and RunPod, with their full history.",
      ),
    ),
    icons: {
      icon: [
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/icon.png", type: "image/png" },
      ],
    },
  };
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Params }>) {
  const locale = await resolveLocale(params);
  const translations = { [locale]: await loadTranslations(locale) };
  return (
    <html lang={locale} dir={localeDir(locale)}>
      <head>
        {/* Geist, as on infrawrench.com. Scripts it lacks (CJK, Hebrew, Arabic,
            Devanagari) fall through to the system fonts in --font-sans. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <I18nProvider locale={locale} translations={translations}>
          <Nav />
          <div className="page-content flex-1">{children}</div>
          <Footer />
        </I18nProvider>
      </body>
    </html>
  );
}
