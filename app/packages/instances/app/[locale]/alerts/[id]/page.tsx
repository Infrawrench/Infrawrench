import type { Metadata } from "next";
import { msg } from "gt-react";
import { notFound } from "next/navigation";
import { AlertManager } from "@/components/chat/AlertManager";
import { isLocale } from "@/lib/i18n/locales";
import { getTranslator } from "@/lib/i18n/server";

/**
 * `/alerts/<id>`: the link in alert emails, to confirm a subscription or stop
 * it. The id is the credential, so the page is a static shell and the alert
 * is fetched in the browser; nothing about it is cached or rendered on the
 * server.
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
    title: tr(msg("Email alert - Infrawrench Instances")),
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params }: { params: Params }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  return <AlertManager id={id} />;
}
