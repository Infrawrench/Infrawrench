import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InstanceView } from "@/components/InstanceView";
import { msg } from "gt-react";
import { describe } from "@/lib/describe";
import { LOCALES, isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadInstance } from "@/lib/load";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/**
 * None at build time: there are about 6,500 instances, and the KV binding is
 * only there at request time. Listing none still makes each page ISR, rendered
 * on its first request and cached; a dynamic segment with no
 * `generateStaticParams` would render on every request instead.
 */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; platform: string; instance: string }>;

async function load(params: Params) {
  const { locale, platform, instance } = await params;
  if (!isLocale(locale)) notFound();
  const [model, tr] = await Promise.all([
    loadInstance(platform, decodeURIComponent(instance)),
    getTranslator(locale),
  ]);
  if (!model) notFound();
  return { model, locale, tr };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { model, locale, tr } = await load(params);
  const title = tr(msg("{name} pricing and specs - Infrawrench Instances"), { name: model.name });
  const description = describe(model, tr, locale);
  const path = `/aws/${model.platform}/${model.name}`;
  const url = localePath(locale, path);
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
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { model, locale, tr } = await load(params);
  return <InstanceView model={model} description={describe(model, tr, locale)} />;
}
