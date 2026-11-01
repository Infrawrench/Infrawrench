import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { Chat } from "@/components/chat/Chat";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";

/** The page is the same for everyone; the conversation lives in the browser. */
export const revalidate = 86400;

/** Rendered on first request and cached, like the instance pages (see there). */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const tr = await getTranslator(locale);
  const title = tr(msg("Ask anything about AWS instance prices - Infrawrench Instances"));
  const description = tr(
    msg(
      "Ask in plain language about AWS instance types, specs and prices in every region, with their history, and get answers as tables and charts you can share.",
    ),
  );
  return {
    title,
    description,
    alternates: {
      canonical: localePath(locale, "/"),
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, "/")])),
        "x-default": "/",
      },
      types: { "text/markdown": "/index.md" },
    },
    openGraph: {
      title,
      description,
      url: localePath(locale, "/"),
      siteName: "Infrawrench Instances",
      locale,
    },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <Chat persist />;
}
