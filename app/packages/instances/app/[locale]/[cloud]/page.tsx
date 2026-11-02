import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { IndexView } from "@/components/IndexView";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadIndex } from "@/lib/load";
import { CLOUDS, isCloud } from "@/lib/platforms";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/**
 * `/aws`, `/azure`, `/gcp`, `/alibaba`, `/runpod`: one cloud's services, linking to each
 * listing. Rendered on first request and cached, like the instance pages (see
 * there).
 */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; cloud: string }>;

async function load(params: Params) {
  const { locale, cloud } = await params;
  if (!isLocale(locale) || !isCloud(cloud)) notFound();
  return { locale, cloud };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, cloud } = await load(params);
  const tr = await getTranslator(locale);
  const provider = CLOUDS[cloud].label;
  const title = tr(msg("{provider} instance types, specs and prices - Infrawrench Instances"), {
    provider,
  });
  const description = tr(
    msg(
      "Specs and prices for every {provider} instance type, in every region, with the full history of both.",
    ),
    { provider },
  );
  const path = `/${cloud}`;
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
  const { cloud } = await load(params);
  const platforms = await loadIndex(cloud);
  if (platforms.length === 0) notFound();
  return <IndexView cloud={cloud} platforms={platforms} />;
}
