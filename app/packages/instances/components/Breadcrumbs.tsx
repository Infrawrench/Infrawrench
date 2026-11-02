"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { localePath } from "@/lib/i18n/locales";
import { MessageIcon } from "./icons";

/**
 * The trail above every page: AWS / EC2 / m5.large. The last item is the
 * current page. With `ask`, a button beside it opens the chat with the box
 * already holding that subject (`/?draft=`, read by `ChatHome`).
 */
export function Breadcrumbs({
  items,
  ask,
}: {
  items: { label: string; href?: string }[];
  ask?: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  return (
    <div className="my-3 flex items-center justify-between gap-3">
      <nav aria-label={gt("Breadcrumb")} className="text-sm text-ink-3">
        <ol className="flex flex-wrap items-center gap-1.5">
          {items.map((item, i) => {
            const last = i === items.length - 1;
            return (
              <li key={item.label} className="flex items-center gap-1.5">
                {last ? (
                  <span aria-current="page" className="text-ink">
                    {item.label}
                  </span>
                ) : item.href ? (
                  <Link className="hover:text-ink hover:underline" href={item.href}>
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
                {!last && <span aria-hidden="true">/</span>}
              </li>
            );
          })}
        </ol>
      </nav>
      {ask && (
        <Link
          href={`${localePath(locale, "/")}?draft=${encodeURIComponent(`${ask} `)}`}
          className="group inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1 text-sm text-ink-2 transition-colors hover:border-accent hover:text-ink"
        >
          <MessageIcon className="h-3.5 w-3.5 text-ink-3 group-hover:text-accent" />
          {gt("Ask about {name}", { name: ask })}
        </Link>
      )}
    </div>
  );
}
