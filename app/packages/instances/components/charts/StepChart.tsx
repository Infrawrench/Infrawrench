"use client";

import { useGT, useLocale } from "gt-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate } from "@/lib/format";
import { stepPaths } from "@/lib/step-path";
import { timeTicks } from "@/lib/time-ticks";

export interface StepSeries {
  id: string;
  label: string;
  /** A CSS color, normally one of the `--series-*` roles. */
  color: string;
  /** `[at, value]`, oldest first; `null` means no value from then on (a gap). */
  points: [number, number | null][];
}

interface Props {
  series: StepSeries[];
  /** Unix seconds the last value runs to. */
  end: number;
  format: (value: number) => string;
  /** Name of the chart for screen readers and the table. */
  label: string;
  /** Start the y axis at zero, for counts. */
  fromZero?: boolean;
  height?: number;
}

const MARGIN = { top: 10, right: 14, bottom: 26, left: 68 };
const DAY = 86400;

/** The value of a step series at time `t`: its newest point at or before `t`. */
function valueAt(points: [number, number | null][], t: number): number | null | undefined {
  let out: number | null | undefined;
  for (const [at, v] of points) {
    if (at > t) break;
    out = v;
  }
  return out;
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step)
    ticks.push(Number(v.toFixed(10)));
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step);
  return ticks;
}

/**
 * A step chart over time: prices hold until they change. Hovering (or arrowing
 * through with the keyboard) snaps a crosshair to the nearest change and lists
 * every series' value at that moment; the same numbers are in the table below.
 */
export function StepChart({ series, end, format, label, fromZero, height = 240 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const gt = useGT();
  const locale = useLocale();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, Math.round(entry!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotted = useMemo(
    () => series.filter((s) => s.points.some(([, v]) => v !== null)),
    [series],
  );

  // Every moment any series changed, oldest first: what the crosshair snaps to.
  const changes = useMemo(() => {
    const set = new Set<number>();
    for (const s of plotted) {
      let prev: number | null | undefined;
      for (const [at, v] of s.points) {
        if (v !== prev) set.add(at);
        prev = v;
      }
    }
    return [...set].sort((a, b) => a - b);
  }, [plotted]);

  const geometry = useMemo(() => {
    const values = plotted.flatMap((s) => s.points.flatMap(([, v]) => (v === null ? [] : [v])));
    if (values.length === 0) return null;
    const t0 = Math.min(...plotted.map((s) => s.points[0]![0]));
    const t1 = Math.max(end, ...changes) + DAY;
    let lo = Math.min(...values);
    const hi = Math.max(...values);
    if (fromZero || lo < hi * 0.35) lo = 0;
    const yTicks = niceTicks(lo, hi, 4);
    const y0 = yTicks[0]!;
    const y1 = yTicks.at(-1)!;
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const x = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0)) * innerW;
    const y = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
    return { t0, t1, x, y, yTicks, innerW, innerH, xTicks: timeTicks(t0, t1, locale) };
  }, [plotted, changes, end, width, height, fromZero, locale]);

  if (!geometry) {
    return (
      <p className="py-6 text-sm text-ink-3">{gt("No prices to chart for this selection.")}</p>
    );
  }
  const { t0, t1, x, y, yTicks, xTicks } = geometry;

  const paths = plotted.map((s) => ({ s, ...stepPaths(s.points, t1, x, y) }));

  const activeT = active === null ? null : changes[active]!;
  const readout =
    activeT === null
      ? []
      : plotted.map((s) => ({ s, v: valueAt(s.points, activeT) })).filter((r) => r.v !== undefined);

  function snap(clientX: number, rect: DOMRect) {
    const t = t0 + ((clientX - rect.left - MARGIN.left) / geometry!.innerW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < changes.length; i++) {
      if (Math.abs(changes[i]! - t) < Math.abs(changes[best]! - t)) best = i;
    }
    setActive(changes.length > 0 ? best : null);
  }

  const tipLeft = activeT === null ? 0 : x(activeT);
  const showDots = changes.length <= 80;

  return (
    <div>
      {plotted.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden="true">
          {plotted.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={gt("{label}. Use the arrow keys to step through changes.", { label })}
          tabIndex={0}
          className="block touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          onPointerMove={(e) => snap(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => snap(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (changes.length === 0) return;
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              const step = e.key === "ArrowLeft" ? -1 : 1;
              setActive((a) =>
                Math.min(
                  changes.length - 1,
                  Math.max(0, a === null ? changes.length - 1 : a + step),
                ),
              );
            } else if (e.key === "Home") setActive(0);
            else if (e.key === "End") setActive(changes.length - 1);
            else if (e.key === "Escape") setActive(null);
          }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--grid)"
              />
              <text
                x={MARGIN.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--ink-3)"
              >
                {format(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={t.at}
              x={x(t.at)}
              y={height - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--ink-3)"
            >
              {t.label}
            </text>
          ))}
          {paths.map(({ s, solid, dashed }) => (
            <g key={s.id}>
              {dashed && (
                <path
                  d={dashed}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  opacity={0.7}
                />
              )}
              <path d={solid} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            </g>
          ))}
          {showDots &&
            paths.map(({ s, dots }) =>
              dots.map((d) => (
                <circle
                  key={`${s.id}-${d.at}`}
                  cx={x(d.at)}
                  cy={y(d.value)}
                  r={2.5}
                  fill={s.color}
                />
              )),
            )}
          {activeT !== null && (
            <g pointerEvents="none">
              <line
                x1={x(activeT)}
                x2={x(activeT)}
                y1={MARGIN.top}
                y2={height - MARGIN.bottom}
                stroke="var(--ink-3)"
                strokeDasharray="3 3"
              />
              {readout.map(({ s, v }) =>
                v === null || v === undefined ? null : (
                  <circle
                    key={s.id}
                    cx={x(activeT)}
                    cy={y(v)}
                    r={4.5}
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ),
              )}
            </g>
          )}
        </svg>
        {activeT !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-20 min-w-40 rounded-md border border-line bg-surface px-2.5 py-2 text-xs shadow-lg"
            style={tipLeft > width / 2 ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
          >
            <div className="mb-1 text-ink-3">{formatDate(activeT, locale)}</div>
            {readout.map(({ s, v }) => (
              <div key={s.id} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums text-ink">
                  {v === null || v === undefined ? gt("Not offered") : format(v)}
                </span>
                {plotted.length > 1 && <span className="text-ink-2">{s.label}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-ink-3 hover:text-ink">
          {gt("Show as a table")}
        </summary>
        <div className="mt-2 max-h-72 overflow-auto rounded border border-line">
          <table className="w-full border-collapse">
            <caption className="sr-only">{label}</caption>
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th className="px-2 py-1 text-left font-medium">{gt("Date")}</th>
                {plotted.map((s) => (
                  <th key={s.id} className="px-2 py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...changes].reverse().map((t) => (
                <tr key={t} className="border-t border-line">
                  <td className="px-2 py-1 tabular-nums text-ink-2">{formatDate(t, locale)}</td>
                  {plotted.map((s) => {
                    const v = valueAt(s.points, t);
                    return (
                      <td key={s.id} className="px-2 py-1 text-right tabular-nums">
                        {v === undefined ? "" : v === null ? gt("Not offered") : format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
