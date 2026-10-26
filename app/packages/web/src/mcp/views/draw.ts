/**
 * Drawing for the MCP views: a small DOM builder, number formatting, and
 * plain SVG charts. No chart library, since each view is a single HTML page
 * an MCP client loads whole.
 */

/**
 * Client-core's chart colours and "Other" key, put in by the build
 * (`app-views-build.ts`) rather than imported: client-core isn't free of
 * side effects, and importing it puts ~33 KB of it in every view.
 */
declare const __IW_CHART__: { series: string[]; other: string; otherKey: string };
export const CHART = __IW_CHART__;

type Child = Node | string | number | null | undefined | false;

/** An element with attributes and children; `on*` attributes that are functions become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...nodes(children));
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG element, the same way. */
function s(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) el.setAttribute(key, String(value));
  }
  el.append(...nodes(children));
  return el;
}

function nodes(children: Child[]): Array<Node | string> {
  return children.flatMap((c) =>
    c === null || c === undefined || c === false ? [] : [typeof c === "number" ? String(c) : c],
  );
}

/** The colour of the series at `rank`: "Other" is always grey. */
export function seriesColor(rank: number, other = false): string {
  return other ? CHART.other : (CHART.series[rank % CHART.series.length] ?? "#60a5fa");
}

/** Money in its currency, or a plain number for a quantity (no currency). */
export function money(amount: number, currency: string, compact = false): string {
  try {
    return new Intl.NumberFormat(undefined, {
      ...(currency ? { style: "currency", currency } : {}),
      ...(compact
        ? { notation: "compact", maximumFractionDigits: 1 }
        : { maximumFractionDigits: Math.abs(amount) < 100 ? 2 : 0 }),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`.trim();
  }
}

/** A number for an axis: short, with its unit when there is one. */
export function quantity(value: number, unit?: string): string {
  const n = new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
  if (!unit) return n;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

/** A round number at or above `max`, for an axis to end on. */
function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

export function legend(items: Array<{ label: string; color: string }>): HTMLElement {
  return h(
    "div",
    { class: "legend" },
    ...items.map((i) => h("span", {}, h("i", { style: `background:${i.color}` }), i.label)),
  );
}

const WIDTH = 640;
const LEFT = 56;
const BOTTOM = 18;

function axis(
  height: number,
  max: number,
  format: (v: number) => string,
  width = WIDTH,
): SVGElement[] {
  const plot = height - BOTTOM;
  return [0, 0.25, 0.5, 0.75, 1].flatMap((f) => {
    const y = plot - f * plot;
    return [
      s("line", { class: "grid", x1: LEFT, x2: width, y1: y, y2: y }),
      s("text", { x: LEFT - 6, y: y + 3, "text-anchor": "end" }, format(f * max)),
    ];
  });
}

/** Labels for the first, middle and last of `labels` along the bottom. */
function xLabels(labels: string[], x: (i: number) => number, height: number): SVGElement[] {
  const picks = [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])];
  return picks
    .filter((i) => i >= 0 && labels[i] !== undefined)
    .map((i) =>
      s(
        "text",
        {
          x: x(i),
          y: height - 4,
          "text-anchor": i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle",
        },
        labels[i],
      ),
    );
}

export interface Stack {
  label: string;
  color: string;
  values: number[];
}

/** Stacked bars, one per bucket. Negative amounts (credits) aren't stacked. */
export function stackedBars(
  buckets: string[],
  stacks: Stack[],
  format: (v: number) => string,
  height = 180,
): SVGElement {
  const totals = buckets.map((_, i) =>
    stacks.reduce((sum, st) => sum + Math.max(0, st.values[i] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const plot = height - BOTTOM;
  const band = (WIDTH - LEFT) / Math.max(1, buckets.length);
  const bar = Math.max(1, band * 0.72);
  const x = (i: number) => LEFT + band * i + (band - bar) / 2;
  const rects: SVGElement[] = [];
  buckets.forEach((bucket, i) => {
    let top = plot;
    for (const st of stacks) {
      const value = Math.max(0, st.values[i] ?? 0);
      if (value === 0) continue;
      const h = (value / max) * plot;
      top -= h;
      rects.push(
        s(
          "rect",
          { x: x(i), y: top, width: bar, height: h, fill: st.color, rx: 1 },
          s("title", {}, `${bucket} · ${st.label}: ${format(value)}`),
        ),
      );
    }
  });
  return s(
    "svg",
    { viewBox: `0 0 ${WIDTH} ${height}`, role: "img" },
    ...axis(height, max, format),
    ...rects,
    ...xLabels(buckets, (i) => x(i) + bar / 2, height),
  );
}

export interface Line {
  label: string;
  color: string;
  points: Array<{ x: number; y: number }>;
  dashed?: boolean;
}

/** Lines over a shared X range; a narrower `width` draws its text larger. */
export function lines(
  series: Line[],
  formatX: (x: number) => string,
  formatY: (y: number) => string,
  height = 140,
  width = WIDTH,
): SVGElement {
  const all = series.flatMap((l) => l.points);
  const xs = all.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const max = niceMax(Math.max(0, ...all.map((p) => p.y)));
  const plot = height - BOTTOM;
  const x = (v: number) => LEFT + ((v - minX) / Math.max(1, maxX - minX)) * (width - LEFT);
  const y = (v: number) => plot - (Math.max(0, v) / max) * plot;
  const paths = series.map((l) =>
    s("path", {
      d: l.points
        .map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`)
        .join(""),
      fill: "none",
      stroke: l.color,
      "stroke-width": 1.75,
      "stroke-dasharray": l.dashed ? "4 3" : undefined,
      "stroke-linejoin": "round",
    }),
  );
  const labels = all.length ? [formatX(minX), formatX((minX + maxX) / 2), formatX(maxX)] : [];
  return s(
    "svg",
    { viewBox: `0 0 ${width} ${height}`, role: "img" },
    ...axis(height, max, formatY, width),
    ...paths,
    ...xLabels(labels, (i) => LEFT + (i / 2) * (width - LEFT), height),
  );
}

/** Horizontal bars, one per row, labelled, for spend by value rather than by date. */
export function rankedBars(
  rows: Array<{ label: string; value: number; color: string }>,
  format: (v: number) => string,
): HTMLElement {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return h(
    "div",
    { class: "stack" },
    ...rows.map((r) =>
      h(
        "div",
        {},
        h(
          "div",
          { class: "row spread" },
          h("span", {}, r.label),
          h("span", { class: "sub" }, format(r.value)),
        ),
        h(
          "div",
          { style: "height:6px;border-radius:3px;background:var(--iw-panel);margin-top:3px" },
          h("div", {
            style: `height:6px;border-radius:3px;background:${r.color};width:${Math.max(0, (r.value / max) * 100).toFixed(1)}%`,
          }),
        ),
      ),
    ),
  );
}

/** Replaces what's in `root` with `children`. */
export function render(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren(...nodes(children));
}
