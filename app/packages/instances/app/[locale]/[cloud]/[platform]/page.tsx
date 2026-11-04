import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { PlatformView } from "@/components/PlatformView";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadListing } from "@/lib/load";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { CLOUDS, fullLabel, platformAt, platformPath } from "@/lib/platforms";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/** Rendered on first request and cached, like the instance pages (see there). */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; cloud: string; platform: string }>;

async function load(params: Params) {
  const { locale, cloud, platform: slug } = await params;
  if (!isLocale(locale)) notFound();
  const platform = platformAt(cloud, slug);
  const listing = platform ? await loadListing(platform) : null;
  if (!listing) notFound();
  return { locale, listing };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, listing } = await load(params);
  const tr = await getTranslator(locale);
  const platform = fullLabel(listing.platform);
  const title = tr(msg("{platform} instance types: specs and prices by region"), { platform });
  const description =
    listing.cloud === "runpod"
      ? tr(
          msg(
            "Every {platform} GPU type and CPU pod size: specs and prices, with their full history.",
          ),
          { platform },
        )
      : tr(
          msg(
            "Every {platform} instance type, by family: specs and prices in every region, with their full history.",
          ),
          { platform },
        );
  const path = platformPath(listing.platform);
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
  const { locale, listing } = await load(params);
  const jsonLd = breadcrumbJsonLd(locale, [
    { name: CLOUDS[listing.cloud].label, path: `/${listing.cloud}` },
    { name: listing.label, path: platformPath(listing.platform) },
  ]);
  // Keyed so moving between services starts with an empty filter.
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <PlatformView key={listing.platform} listing={listing} />
    </>
  );
}
