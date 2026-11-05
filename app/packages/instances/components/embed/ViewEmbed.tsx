"use client";

import { useGT, useLocale } from "gt-react";
import type { ViewData } from "@/lib/chat/types";
import { localePath } from "@/lib/i18n/locales";
import { ViewCard } from "../chat/ViewCard";
import { EmbedBrand, EmbedShell } from "./EmbedShell";

/**
 * A table or chart from the chat in an X Player Card. Asking a follow-up needs
 * a form and the chat's storage, so the secondary action opens the shared page,
 * which has the question box.
 */
export function ViewEmbed({ data }: { data: ViewData }) {
  const gt = useGT();
  const locale = useLocale();
  return (
    <EmbedShell
      kind="view"
      fullHref={localePath(locale, `/v/${data.view.id}`)}
      fullLabel={
        data.view.kind === "table" ? gt("Ask about this table") : gt("Ask about this chart")
      }
    >
      <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col p-2">
        <ViewCard data={data} fill embed headerEnd={<EmbedBrand kind="view" />} />
      </main>
    </EmbedShell>
  );
}
