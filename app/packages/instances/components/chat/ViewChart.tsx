"use client";

import { useLocale } from "gt-react";
import { useMemo, useState } from "react";
import { formatCell, inferFormat, parseDateTime } from "@/lib/chat/format";
import type { ChartSpec, QueryResult } from "@/lib/chat/types";
import { BarChart } from "../charts/BarChart";
import { StepChart, type StepSeries } from "../charts/StepChart";
import { useUnits } from "./DataTable";

/** Bars drawn before the rest are folded behind "Show all". */
const BARS = 60;
/** Lines a line chart draws; more series than this would be unreadable. */
const SERIES = 8;
const COLORS = Array.from({ length: SERIES }, (_, i) => `var(--series-${i + 1})`);

export function ViewChart({
  spec,
  result,
  showAllLabel,
  label,
}: {
  spec: ChartSpec;
  result: QueryResult;
  showAllLabel: (count: number) => string;
  label: string;
}) {
  const locale = useLocale();
  const units = useUnits();
  const [all, setAll] = useState(false);
  const col = (name: string | undefined) => result.columns.findIndex((c) => c.name === name);
  const xi = col(spec.x);
  const yi = col(spec.y);
  const si = col(spec.series);
  const format = spec.format ?? inferFormat(spec.y, result.columns[yi]?.type ?? "");
  const fmt = (v: number) => formatCell(v, format, locale, units);

  const series = useMemo((): { list: StepSeries[]; end: number } => {
    if (spec.chart !== "line") return { list: [], end: 0 };
    const groups = new Map<string, [number, number | null][]>();
    let end = 0;
    for (const row of result.rows) {
      const at = parseDateTime(row[xi] ?? null);
      const v = row[yi];
      if (at === null) continue;
      end = Math.max(end, at);
      const key = si >= 0 ? String(row[si] ?? "") : spec.y;
      if (!groups.has(key) && groups.size >= SERIES) continue;
      const points = groups.get(key) ?? [];
      points.push([at, typeof v === "number" ? v : null]);
      groups.set(key, points);
    }
    const list = [...groups].map(([key, points], i) => ({
      id: key,
      label: key,
      color: COLORS[i]!,
      points: points.sort((a, b) => a[0] - b[0]),
    }));
    // A step chart holds each value until the next; run the last one to now.
    return { list, end: Math.max(end, Math.floor(Date.now() / 1000)) };
  }, [spec, result, xi, yi, si]);

  if (xi < 0 || yi < 0) return null;

  if (spec.chart === "line") {
    return (
      <div className="px-3 py-3">
        <StepChart series={series.list} end={series.end} format={fmt} label={label} />
        {series.list.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            {series.list.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const bars = result.rows
    .filter((row) => typeof row[yi] === "number")
    .map((row, i) => ({
      id: `${i}`,
      label: String(row[xi] ?? ""),
      value: row[yi] as number,
    }));
  return (
    <div className="px-3 py-3">
      <BarChart bars={all ? bars : bars.slice(0, BARS)} format={fmt} label={label} />
      {bars.length > BARS && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 text-sm text-accent hover:underline"
        >
          {showAllLabel(bars.length)}
        </button>
      )}
    </div>
  );
}
