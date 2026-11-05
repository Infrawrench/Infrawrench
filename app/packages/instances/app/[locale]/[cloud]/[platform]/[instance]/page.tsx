import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InstanceView } from "@/components/InstanceView";
import { describe, instanceTitle } from "@/lib/describe";
import { instanceHasPlayerCard, playerCardTags } from "@/lib/embed";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadInstance } from "@/lib/load";
import { breadcrumbJsonLd } from "@/lib/jsonld";
import { CLOUDS, cloudOf, instancePath, platformAt, platformPath } from "@/lib/platforms";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/**
 * None at build time: there are about 7,700 instances, and the KV binding is
 * only there at request time. Listing none still makes each page ISR, rendered
 * on its first request and cached; a dynamic segment with no
 * `generateStaticParams` would render on every request instead.
 */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; cloud: string; platform: string; instance: string }>;

async function load(params: Params) {
  const { locale, cloud, platform: slug, instance } = await params;
  if (!isLocale(locale)) notFound();
  const platform = platformAt(cloud, slug);
  if (!platform) notFound();
  const [model, tr] = await Promise.all([
    loadInstance(platform, decodeURIComponent(instance)),
    getTranslator(locale),
  ]);
  if (!model) notFound();
  return { model, locale, tr };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { model, locale, tr } = await load(params);
  const title = instanceTitle(model, tr, locale);
  const description = describe(model, tr, locale);
  const path = instancePath(model.platform, model.name);
  const url = localePath(locale, path);
  const player = instanceHasPlayerCard(path);
  // The image itself comes from opengraph-image.tsx beside this file.
  return {
    title,
    description,
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, path)])),
        "x-default": path,
      },
      // The same data as Markdown, for agents (proxy.ts also answers
      // `Accept: text/markdown` on the page URL itself).
      types: { "text/markdown": `${path}.md` },
    },
    openGraph: {
      title,
      description,
      url,
      siteName: "Infrawrench Instances",
      type: "website",
      locale,
    },
    twitter: { card: player ? "player" : "summary_large_image", title, description },
    ...(player ? { other: playerCardTags(locale, path) } : {}),
  };
}

export default async function Page({ params }: { params: Params }) {
  const { model, locale, tr } = await load(params);
  // Keyed: a client-side navigation to another instance mounts a fresh view
  // rather than carrying over the last one's region, variant and loaded data.
  const cloud = cloudOf(model.platform);
  const jsonLd = breadcrumbJsonLd(locale, [
    { name: CLOUDS[cloud].label, path: `/${cloud}` },
    { name: model.platformLabel, path: platformPath(model.platform) },
    { name: model.name, path: instancePath(model.platform, model.name) },
  ]);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <InstanceView
        key={`${model.platform}/${model.name}`}
        model={model}
        description={describe(model, tr, locale)}
      />
    </>
  );
}
