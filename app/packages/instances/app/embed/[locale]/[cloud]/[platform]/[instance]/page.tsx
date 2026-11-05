import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { InstanceEmbed } from "@/components/embed/InstanceEmbed";
import { instanceTitle } from "@/lib/describe";
import { isLocale } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";
import { loadInstance } from "@/lib/load";
import { platformAt } from "@/lib/platforms";

/** The sync Action refreshes the data twice an hour. */
export const revalidate = 1800;

/** None at build time, for the same reason as the instance page: rendered and cached on demand. */
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; cloud: string; platform: string; instance: string }>;

const load = cache(async (locale: string, cloud: string, slug: string, instance: string) => {
  if (!isLocale(locale)) return null;
  const platform = platformAt(cloud, slug);
  return platform ? loadInstance(platform, decodeURIComponent(instance)) : null;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, cloud, platform, instance } = await params;
  const model = await load(locale, cloud, platform, instance);
  if (!model) notFound();
  return { title: instanceTitle(model, await getTranslator(locale), locale) };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, cloud, platform, instance } = await params;
  const model = await load(locale, cloud, platform, instance);
  if (!model) notFound();
  return <InstanceEmbed key={`${model.platform}/${model.name}`} model={model} />;
}
