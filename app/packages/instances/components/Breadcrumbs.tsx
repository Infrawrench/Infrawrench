"use client";

import { useGT } from "gt-react";

/** The trail above every page: AWS / EC2 / m5.large. The last item is the current page. */
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  const gt = useGT();
  return (
    <nav aria-label={gt("Breadcrumb")} className="my-3 text-sm text-ink-3">
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
                <a className="hover:text-ink hover:underline" href={item.href}>
                  {item.label}
                </a>
              ) : (
                item.label
              )}
              {!last && <span aria-hidden="true">/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
