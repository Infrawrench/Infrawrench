import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { Chat } from "@/components/chat/Chat";
import { isLocale } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";

/**
 * `/chat/<id>`: one conversation. The page is a static shell; the browser
 * keeps the conversation under its id (`lib/chat/storage.ts`), so a reload or
 * the back button finds it again. The home page opens it with `?q=` for the
 * first question.
 */
export const revalidate = 86400;

export function generateStaticParams() {
  return [];
}

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const tr = await getTranslator(locale);
  return {
    title: tr(msg("Conversation - Infrawrench Instances")),
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-z]{6,32}$/.test(id)) notFound();
  return <Chat key={id} conversationId={id} />;
}
