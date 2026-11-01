"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { useMemo, useState } from "react";
import { useDataString } from "@/lib/i18n/data-string";
import { localePath } from "@/lib/i18n/locales";
import type { PlatformListing } from "@/lib/load";
import { Breadcrumbs } from "./Breadcrumbs";

/** "m5large" finds "m5.large"; "r6g search" finds "r6g.large.search". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[.\-_\s()]/g, "");
}

/** One service: every family, and every instance type in it, with a filter. */
export function PlatformView({ listing }: { listing: PlatformListing }) {
  const gt = useGT();
  const tr = useDataString();
  const locale = useLocale();
  const [query, setQuery] = useState("");

  const families = useMemo(() => {
    const q = normalize(query);
    if (!q) return listing.families;
    return listing.families.flatMap((f) => {
      if (normalize(f.label).includes(q)) return [f];
      const instances = f.instances.filter((n) => normalize(n).includes(q));
      return instances.length > 0 ? [{ ...f, instances }] : [];
    });
  }, [listing.families, query]);

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-4 sm:px-7">
      <Breadcrumbs
        items={[{ label: "AWS", href: localePath(locale, "/aws") }, { label: listing.label }]}
      />
      <h1 className="text-2xl font-bold">
        {gt("{platform} instance types", { platform: listing.label })}
      </h1>
      <p className="mt-1 text-ink-2">{tr(listing.summary)}</p>
      <p className="mt-0.5 text-sm text-ink-3">
        {gt(
          "{count, plural, one {# instance type} other {# instance types}} in {families, plural, one {# family} other {# families}}.",
          { count: listing.instances, families: listing.families.length },
        )}
      </p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={gt("Filter by family or instance type")}
        aria-label={gt("Filter by family or instance type")}
        className="mt-5 w-full max-w-md rounded-md border border-line bg-surface px-3 py-2 text-base text-ink sm:text-sm placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
      />

      {families.length === 0 ? (
        <p className="mt-6 text-sm text-ink-3">{gt("No instance types match.")}</p>
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {families.map((f) => (
            <li key={f.key} className="rounded-lg border border-line p-3">
              <h2 className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{f.key ? f.label : gt("Other")}</span>
                <span className="text-xs text-ink-3">{f.instances.length}</span>
              </h2>
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {f.instances.map((name) => (
                  <li key={name}>
                    {/* Up to ~2,000 links on a page: no prefetching; clicks still
                        navigate client-side. */}
                    <Link
                      className="text-accent hover:text-accent-hover hover:underline"
                      href={localePath(locale, `/aws/${listing.platform}/${name}`)}
                      prefetch={false}
                    >
                      {name}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
