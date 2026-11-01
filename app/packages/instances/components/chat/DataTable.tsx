"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCell, numericFilter, type DisplayColumn, type Units } from "@/lib/chat/format";
import type { Cell } from "@/lib/chat/types";
import { localePath } from "@/lib/i18n/locales";
import { ColumnsIcon, SortIcon } from "../icons";

/** Rows rendered before "Show more". */
const PAGE = 100;

export function useUnits(): Units {
  const gt = useGT();
  return useMemo(
    () => ({
      perHour: (price: string) => gt("{price}/hr", { price }),
      perMonth: (price: string) => gt("{price}/mo", { price }),
      gib: (amount: string) => gt("{amount} GiB", { amount }),
      yes: gt("Yes"),
      no: gt("No"),
    }),
    [gt],
  );
}

/**
 * The chat's interactive table: sort by any column (click its header), filter
 * per column (text contains, or `>4`, `<=0.05`, `2..8` on numbers) and across
 * all of them, and choose which columns show. Works on the rows the view
 * loaded.
 */
export function DataTable({
  columns,
  rows,
  initialSort,
  platform = "ec2",
  visibleRef,
}: {
  columns: DisplayColumn[];
  rows: Cell[][];
  initialSort?: { column: string; direction: "asc" | "desc" } | undefined;
  /** Instance links' platform for rows without a `platform` column. */
  platform?: string;
  /** Receives the columns and rows on screen (after filters and sort), for the CSV download. */
  visibleRef?: React.RefObject<{ columns: DisplayColumn[]; rows: Cell[][] } | null>;
}) {
  const gt = useGT();
  const locale = useLocale();
  const units = useUnits();
  const [sort, setSort] = useState<{ index: number; direction: "asc" | "desc" } | null>(() => {
    const index = initialSort ? columns.findIndex((c) => c.name === initialSort.column) : -1;
    return index >= 0 ? { index, direction: initialSort!.direction } : null;
  });
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [limit, setLimit] = useState(PAGE);
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picker) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicker(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picker]);

  const shown = columns.filter((c) => !hidden.has(c.index));
  const platformIndex = columns.find((c) => c.name === "platform")?.index;

  const filtered = useMemo(() => {
    const tests = Object.entries(filters)
      .filter(([, text]) => text.trim())
      .map(([i, text]) => {
        const column = columns[Number(i)]!;
        const numeric = column.numeric ? numericFilter(text) : null;
        const needle = text.trim().toLowerCase();
        return (row: Cell[]) => {
          const v = row[column.index];
          if (numeric) return typeof v === "number" && numeric(v);
          return String(v ?? "")
            .toLowerCase()
            .includes(needle);
        };
      });
    const needle = search.trim().toLowerCase();
    const out = rows.filter(
      (row) =>
        tests.every((t) => t(row)) &&
        (!needle ||
          row.some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(needle),
          )),
    );
    if (sort) {
      const { index, direction } = sort;
      const sign = direction === "asc" ? 1 : -1;
      const collator = new Intl.Collator(locale, { numeric: true });
      out.sort((a, b) => {
        const x = a[index] ?? null;
        const y = b[index] ?? null;
        // Blanks last either way.
        if (x === null || x === "") return y === null || y === "" ? 0 : 1;
        if (y === null || y === "") return -1;
        if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
        return collator.compare(String(x), String(y)) * sign;
      });
    }
    return out;
  }, [rows, filters, search, sort, columns, locale]);

  useEffect(() => {
    if (visibleRef) visibleRef.current = { columns: shown, rows: filtered };
  });

  // Ascending, descending, then back to the query's order.
  const cycleSort = (index: number) =>
    setSort((s) =>
      s?.index !== index
        ? { index, direction: "asc" }
        : s.direction === "asc"
          ? { index, direction: "desc" }
          : null,
    );

  const render = (column: DisplayColumn, row: Cell[]) => {
    const value = row[column.index] ?? null;
    const text = formatCell(value, column.format, locale, units);
    if (column.format === "instance" && typeof value === "string" && value) {
      const rowPlatform =
        platformIndex !== undefined ? String(row[platformIndex] ?? platform) : platform;
      return (
        <Link
          prefetch={false}
          href={localePath(
            locale,
            `/aws/${encodeURIComponent(rowPlatform)}/${encodeURIComponent(value)}`,
          )}
          className="font-medium text-accent hover:underline"
        >
          {value}
        </Link>
      );
    }
    return text;
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(PAGE);
          }}
          placeholder={gt("Search all columns")}
          aria-label={gt("Search all columns")}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-3 focus:border-accent"
        />
        <span className="text-xs text-ink-3 tabular-nums">
          {filtered.length === rows.length
            ? gt("{count, plural, one {# row} other {# rows}}", { count: rows.length })
            : gt("{shown} of {count} rows", { shown: filtered.length, count: rows.length })}
        </span>
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={() => setPicker((p) => !p)}
            aria-expanded={picker}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:border-ink-3 hover:text-ink"
          >
            <ColumnsIcon className="h-3.5 w-3.5" />
            {gt("Columns")}
          </button>
          {picker && (
            <div className="absolute right-0 z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-lg">
              {columns.map((c) => (
                <label
                  key={c.index}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.index)}
                    onChange={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (next.has(c.index)) next.delete(c.index);
                        else if (shown.length > 1) next.add(c.index);
                        return next;
                      })
                    }
                  />
                  <span className="truncate">{c.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              {shown.map((c) => {
                const direction = sort?.index === c.index ? sort.direction : null;
                return (
                  <th
                    key={c.index}
                    scope="col"
                    aria-sort={
                      direction === "asc"
                        ? "ascending"
                        : direction === "desc"
                          ? "descending"
                          : "none"
                    }
                    className={`px-3 pt-2 pb-1 font-semibold whitespace-nowrap ${c.numeric ? "text-right" : "text-left"}`}
                  >
                    <button
                      type="button"
                      onClick={() => cycleSort(c.index)}
                      className={`inline-flex items-center gap-1 hover:text-accent ${c.numeric ? "flex-row-reverse" : ""}`}
                    >
                      {c.label}
                      <SortIcon direction={direction} className="h-3 w-3 shrink-0" />
                    </button>
                  </th>
                );
              })}
            </tr>
            <tr>
              {shown.map((c) => (
                <th key={c.index} className="px-2 pb-2">
                  <input
                    value={filters[c.index] ?? ""}
                    onChange={(e) => {
                      setFilters((f) => ({ ...f, [c.index]: e.target.value }));
                      setLimit(PAGE);
                    }}
                    placeholder={c.numeric ? gt("e.g. <0.1") : gt("Filter")}
                    aria-label={gt("Filter {column}", { column: c.label })}
                    className={`w-full min-w-16 rounded border border-line bg-surface px-1.5 py-1 text-xs font-normal outline-none placeholder:text-ink-3 focus:border-accent ${c.numeric ? "text-right" : ""}`}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((row, r) => (
              <tr key={r} className="border-t border-line hover:bg-surface-2/60">
                {shown.map((c) => (
                  <td
                    key={c.index}
                    className={`px-3 py-1.5 whitespace-nowrap ${c.numeric ? "text-right tabular-nums" : ""}`}
                  >
                    {render(c, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-ink-3">
            {gt("No rows match the filters.")}
          </p>
        )}
      </div>
      {filtered.length > limit && (
        <div className="border-t border-line px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE * 5)}
            className="text-sm text-accent hover:underline"
          >
            {gt("Show more ({count, plural, one {# left} other {# left}})", {
              count: filtered.length - limit,
            })}
          </button>
        </div>
      )}
    </div>
  );
}
