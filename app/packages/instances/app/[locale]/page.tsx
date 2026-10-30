import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { IndexView } from "@/components/IndexView";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadIndex } from "@/lib/load";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/** Rendered on first request and cached, like the instance pages (see there). */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const tr = await getTranslator(locale);
  const title = tr(msg("AWS instance types, specs and prices - Infrawrench Instances"));
  const description = tr(
    msg(
      "Specs and prices for every AWS instance type, in every region, with the full history of both.",
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
  return <IndexView platforms={await loadIndex()} />;
}
