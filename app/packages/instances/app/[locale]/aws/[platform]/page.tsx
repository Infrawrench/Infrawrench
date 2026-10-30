import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { PlatformView } from "@/components/PlatformView";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadListing } from "@/lib/load";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/** Rendered on first request and cached, like the instance pages (see there). */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; platform: string }>;

async function load(params: Params) {
  const { locale, platform } = await params;
  if (!isLocale(locale)) notFound();
  const listing = await loadListing(platform);
  if (!listing) notFound();
  return { locale, listing };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, listing } = await load(params);
  const tr = await getTranslator(locale);
  const title = tr(msg("AWS {platform} instance types - Infrawrench Instances"), {
    platform: listing.label,
  });
  const description = tr(
    msg(
      "Every AWS {platform} instance type, by family: specs and prices in every region, with their full history.",
    ),
    { platform: listing.label },
  );
  const path = `/aws/${listing.platform}`;
  return {
    title,
    description,
    alternates: {
      canonical: localePath(locale, path),
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, path)])),
        "x-default": path,
      },
      types: { "text/markdown": `${path}.md` },
    },
    openGraph: {
      title,
      description,
      url: localePath(locale, path),
      siteName: "Infrawrench Instances",
      locale,
    },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { listing } = await load(params);
  // Keyed so moving between services starts with an empty filter.
  return <PlatformView key={listing.platform} listing={listing} />;
}
