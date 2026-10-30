"use client";

import { useGT, useLocale } from "gt-react";
import { useId, useState } from "react";
import { formatDate } from "@/lib/format";
import type { AttributeStep } from "@/lib/selection";
import { HistoryIcon } from "./icons";

/**
 * The marker next to an attribute that has changed over the instance's life.
 * Hovering or focusing it (or tapping, on touch screens) lists every value it
 * has had, newest first.
 */
export function HistoryBadge({ label, steps }: { label: string; steps: AttributeStep[] }) {
  const gt = useGT();
  const locale = useLocale();
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const newestFirst = [...steps].reverse();
  return (
    <span className="group relative ml-1.5 inline-flex align-middle">
      <button
        type="button"
        aria-label={gt(
          "{label} has changed {count, plural, one {# time} other {# times}}; show history",
          { label, count: steps.length - 1 },
        )}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={() => setPinned((p) => !p)}
        onBlur={() => setPinned(false)}
        className="rounded p-0.5 text-ink-3 hover:text-accent focus-visible:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        <HistoryIcon className="h-3.5 w-3.5" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={`absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-line bg-surface p-2 text-xs shadow-lg group-hover:block group-focus-within:block ${pinned ? "block" : "hidden"}`}
      >
        <span className="mb-1 block font-semibold text-ink">
          {gt("{label} history", { label })}
        </span>
        <span className="block max-h-64 overflow-y-auto">
          {newestFirst.map((s, i) => (
            <span
              key={`${s.at}-${i}`}
              className="flex items-baseline gap-2 border-t border-line py-1 first:border-t-0"
            >
              <span className="w-24 shrink-0 text-ink-3 tabular-nums">
                {formatDate(s.at, locale)}
              </span>
              <span
                className={`min-w-0 flex-1 break-words ${s.value === null ? "text-ink-3 italic" : "text-ink"}`}
              >
                {s.value ?? gt("Removed")}
                {i === 0 && <span className="ml-1 text-ink-3">{gt("(current)")}</span>}
                {i === newestFirst.length - 1 && (
                  <span className="ml-1 text-ink-3">{gt("(first seen)")}</span>
                )}
              </span>
              {s.regional && (
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-ink-2">
                  {gt("this region")}
                </span>
              )}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
