"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { useDataString } from "@/lib/i18n/data-string";
import { localePath } from "@/lib/i18n/locales";
import type { PlatformSummary } from "@/lib/load";
import { ServerIcon } from "./icons";

/** The site's home: one card per AWS service, linking to its listing. */
export function IndexView({ platforms }: { platforms: PlatformSummary[] }) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-8 sm:px-7">
      <h1 className="text-3xl font-bold tracking-tight">{gt("AWS instance types")}</h1>
      <p className="mt-2 max-w-2xl text-ink-2">
        {gt(
          "Specs and prices for every instance type in {count, plural, one {# AWS service} other {# AWS services}}, in every region, with the full history of both.",
          { count: platforms.length },
        )}
      </p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {platforms.map((p) => (
          <li key={p.platform}>
            <Link
              href={localePath(locale, `/aws/${p.platform}`)}
              className="group flex h-full flex-col rounded-lg border border-line p-4 transition-colors hover:border-accent hover:bg-surface-2"
            >
              <span className="flex items-center gap-2 text-lg font-semibold">
                <ServerIcon className="h-4 w-4 text-ink-3 group-hover:text-accent" />
                {p.label}
              </span>
              <span className="mt-1 text-sm text-ink-2">{tr(p.summary)}</span>
              <span className="mt-3 text-xs text-ink-3">
                {gt("{count, plural, one {# instance type} other {# instance types}}", {
                  count: p.instances,
                })}
                {" · "}
                {gt("{count, plural, one {# family} other {# families}}", { count: p.families })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
