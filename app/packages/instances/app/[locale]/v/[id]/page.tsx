import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Chat } from "@/components/chat/Chat";
import { loadView, viewData } from "@/lib/chat/views";
import { isLocale } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";

/**
 * `/v/<id>`: a table or chart someone shared from the chat, re-queried, as the
 * first answer of a new conversation. Cached like the other pages; the data
 * moves only when the sync loads a new price list.
 */
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
  const tr = await getTranslator(locale);
  return {
    title: tr(msg("{title} - Infrawrench Instances"), { title: data.view.title }),
    description: tr(
      msg(
        "A table of AWS instance prices, from AWS's price lists, shared from Infrawrench Instances.",
      ),
    ),
    // Made by visitors, so kept out of search results.
    robots: { index: false, follow: true },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const data = await load(id);
  if (!data) notFound();
  return <Chat key={id} initial={data} />;
}
