import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { cache } from "react";
import { SharedView } from "@/components/chat/Chat";
import { loadView, viewData } from "@/lib/chat/views";
import { playerCardTags } from "@/lib/embed";
import { isLocale, localePath } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";

/**
 * `/v/<id>`: a table or chart someone shared from the chat, filling the
 * window, with a box to ask a follow-up (which opens a conversation starting
 * from it). Cached like the other pages; the data moves only when the sync
 * loads a new price list.
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
  const path = `/v/${id}`;
  const title = data.view.title;
  const description = tr(
    msg(
      "A table of cloud instance prices, from the providers' price lists, shared from Infrawrench Instances.",
    ),
  );
  // The image itself comes from opengraph-image.tsx beside this file.
  return {
    title: tr(msg("{title} - Infrawrench Instances"), { title }),
    description,
    // Made by visitors, so kept out of search results.
    robots: { index: false, follow: true },
    openGraph: {
      title,
      description,
      url: localePath(locale, path),
      siteName: "Infrawrench Instances",
      type: "website",
      locale,
    },
    twitter: { card: "player", title, description },
    other: playerCardTags(locale, path),
  };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const data = await load(id);
  if (!data) notFound();
  return <SharedView key={id} data={data} />;
}
