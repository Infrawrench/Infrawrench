import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ViewEmbed } from "@/components/embed/ViewEmbed";
import { loadView, viewData } from "@/lib/chat/views";
import { isLocale } from "@/lib/i18n/locales";

/** Cached like the shared page: the data moves only when the sync loads a new price list. */
export const revalidate = 1800;

export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; id: string }>;

const load = cache(async (id: string) => {
  const view = await loadView(id);
  return view ? viewData(view) : null;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const data = await load(id);
  if (!data) notFound();
  return { title: data.view.title };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const data = await load(id);
  if (!data) notFound();
  return <ViewEmbed key={id} data={data} />;
}
